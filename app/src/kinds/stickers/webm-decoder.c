// Decodes Telegram's video stickers into RGBA frames for the APNG encoder (convert.ts). A video sticker is a WebM
// file with VP9 video and a transparency channel, which WebM keeps as a second VP9 stream beside the video; libvpx's
// VP9 decoder reads both. Built into WebAssembly with FFmpeg's Matroska reader, libvpx and swscale by
// scripts/build-webm-decoder.sh.
//
// webm_probe reads a file's size, duration and frame rate. webm_render decodes it from the start and writes `count`
// square frames, one per 1 / frame_rate seconds, each the video frame showing at that moment, scaled to fit the
// square and centred on transparency. The scaling is a Lanczos filter followed by sharpening (resize_sharp), on
// colours multiplied by their opacity, so that the colour of transparent pixels does not darken the edges of what
// is visible. The comparison of a copy with its original (compare-pictures.ts) draws the original the same way, so
// a change to the scaling makes the copies that earlier versions made fail it.

#include <emscripten/emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <libswscale/swscale.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char error_text[256];

/** Records why decoding failed, with FFmpeg's reason when `code` is one of its errors; returns an error code. */
static int fail(const char *what, int code) {
  if (code < 0) {
    char reason[AV_ERROR_MAX_STRING_SIZE] = "";
    av_strerror(code, reason, sizeof reason);
    snprintf(error_text, sizeof error_text, "%s: %s", what, reason);
    return code;
  }
  snprintf(error_text, sizeof error_text, "%s", what);
  return AVERROR_INVALIDDATA;
}

/** Why the last call failed. */
EMSCRIPTEN_KEEPALIVE const char *webm_error(void) { return error_text; }

/** The file in memory, read through FFmpeg's input callbacks. */
typedef struct {
  const uint8_t *data;
  int64_t size;
  int64_t position;
} Input;

static int read_input(void *opaque, uint8_t *buffer, int size) {
  Input *input = opaque;
  int64_t left = input->size - input->position;
  if (left <= 0) return AVERROR_EOF;
  if (size > left) size = (int)left;
  memcpy(buffer, input->data + input->position, size);
  input->position += size;
  return size;
}

static int64_t seek_input(void *opaque, int64_t offset, int whence) {
  Input *input = opaque;
  if (whence == AVSEEK_SIZE) return input->size;
  int64_t base = whence == SEEK_CUR ? input->position : whence == SEEK_END ? input->size : 0;
  int64_t position = base + offset;
  if (position < 0 || position > input->size) return AVERROR(EINVAL);
  input->position = position;
  return position;
}

typedef struct {
  Input input;
  AVIOContext *io;
  AVFormatContext *format;
  AVCodecContext *codec;
  AVPacket *packet;
  AVFrame *frame;
  int stream;
  /** Every packet was read and the decoder was told so. */
  int drained;
} Video;

static void video_close(Video *video) {
  av_frame_free(&video->frame);
  av_packet_free(&video->packet);
  avcodec_free_context(&video->codec);
  avformat_close_input(&video->format);
  if (video->io) {
    av_freep(&video->io->buffer);
    avio_context_free(&video->io);
  }
}

static int video_open(Video *video, const uint8_t *data, int size) {
  memset(video, 0, sizeof *video);
  video->input = (Input){data, size, 0};
  const int buffer_size = 32768;
  uint8_t *buffer = av_malloc(buffer_size);
  if (!buffer) return fail("out of memory", AVERROR(ENOMEM));
  video->io = avio_alloc_context(buffer, buffer_size, 0, &video->input, read_input, NULL, seek_input);
  if (!video->io) {
    av_free(buffer);
    return fail("out of memory", AVERROR(ENOMEM));
  }
  video->format = avformat_alloc_context();
  if (!video->format) return fail("out of memory", AVERROR(ENOMEM));
  video->format->pb = video->io;
  int code = avformat_open_input(&video->format, NULL, NULL, NULL);
  if (code < 0) return fail("the file is not a WebM video", code);
  code = avformat_find_stream_info(video->format, NULL);
  if (code < 0) return fail("the video cannot be read", code);
  video->stream = av_find_best_stream(video->format, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
  if (video->stream < 0) return fail("the file has no video", video->stream);
  const AVCodecParameters *parameters = video->format->streams[video->stream]->codecpar;
  if (parameters->codec_id != AV_CODEC_ID_VP9) return fail("the video is not VP9", 0);
  // FFmpeg's own VP9 decoder ignores the transparency channel; libvpx's decodes it.
  const AVCodec *decoder = avcodec_find_decoder_by_name("libvpx-vp9");
  if (!decoder) return fail("the VP9 decoder is missing", 0);
  video->codec = avcodec_alloc_context3(decoder);
  video->packet = av_packet_alloc();
  video->frame = av_frame_alloc();
  if (!video->codec || !video->packet || !video->frame) return fail("out of memory", AVERROR(ENOMEM));
  code = avcodec_parameters_to_context(video->codec, parameters);
  if (code < 0) return fail("the video cannot be read", code);
  code = avcodec_open2(video->codec, decoder, NULL);
  if (code < 0) return fail("the VP9 decoder does not start", code);
  return 0;
}

/** Decodes the next frame into video->frame: 0, AVERROR_EOF after the last frame, or another error. */
static int next_frame(Video *video) {
  for (;;) {
    int code = avcodec_receive_frame(video->codec, video->frame);
    if (code != AVERROR(EAGAIN)) return code;
    code = av_read_frame(video->format, video->packet);
    if (code == AVERROR_EOF && !video->drained) {
      video->drained = 1;
      code = avcodec_send_packet(video->codec, NULL);
      if (code < 0) return code;
      continue;
    }
    if (code < 0) return code;
    if (video->packet->stream_index == video->stream) code = avcodec_send_packet(video->codec, video->packet);
    av_packet_unref(video->packet);
    if (code < 0) return code;
  }
}

/** When the decoded frame starts showing, in seconds; NAN when the file does not say. */
static double frame_time(const Video *video) {
  int64_t timestamp = video->frame->best_effort_timestamp;
  if (timestamp == AV_NOPTS_VALUE) timestamp = video->frame->pts;
  if (timestamp == AV_NOPTS_VALUE) return NAN;
  return timestamp * av_q2d(video->format->streams[video->stream]->time_base);
}

/**
 * Reads a video's width and height, its duration in seconds and its frame rate into `info` (4 doubles; the frame
 * rate is 0 when the file does not say). Decodes the whole video, so that a file that cannot be decoded fails here.
 * Returns the number of frames, or a negative error (webm_error says why).
 */
EMSCRIPTEN_KEEPALIVE int webm_probe(const uint8_t *data, int size, double *info) {
  Video video;
  int code = video_open(&video, data, size);
  int frames = 0;
  double first = NAN, last = NAN;
  while (code >= 0) {
    code = next_frame(&video);
    if (code == AVERROR_EOF) break;
    if (code < 0) {
      fail("the video cannot be decoded", code);
      break;
    }
    if (frames == 0) {
      info[0] = video.frame->width;
      info[1] = video.frame->height;
    }
    double time = frame_time(&video);
    if (isnan(first)) first = time;
    last = time;
    frames++;
  }
  if (code >= 0 || code == AVERROR_EOF) {
    if (frames == 0) {
      code = fail("the video has no frames", 0);
    } else {
      const AVStream *stream = video.format->streams[video.stream];
      double rate = av_q2d(stream->avg_frame_rate);
      if (!(rate > 0) && frames > 1 && last > first) rate = (frames - 1) / (last - first);
      double duration = video.format->duration > 0 ? (double)video.format->duration / AV_TIME_BASE : 0;
      // A stated duration that ends before the last frame starts is wrong: some of Telegram's files state one
      // frame's time for a video of several seconds. Then, and without a duration in the file, the last frame
      // shows for as long as the frames before it did on average.
      const double shown = frames > 1 && last > first ? last - first : 0;
      if (!(duration > shown)) duration = shown > 0 ? shown * frames / (frames - 1) : rate > 0 ? frames / rate : 0;
      info[2] = duration;
      info[3] = rate > 0 ? rate : 0;
      code = frames;
    }
  }
  video_close(&video);
  return code;
}

/** How much of the difference between a scaled picture and its blur is added back to it. */
#define SHARPENING 0.7

static double lanczos3(double x) {
  if (x == 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const double pi_x = M_PI * x;
  return 3 * sin(pi_x) * sin(pi_x / 3) / (pi_x * pi_x);
}

/**
 * One direction of a Lanczos resize from `length` samples to `target_length`: target sample t is the sum of
 * `count` source samples from number first[t] on, each times its weight. The weights of a target sample add up to
 * one. A sample number outside the source stands for the nearest one inside.
 */
typedef struct {
  int count;
  int *first;
  float *weights;
} Taps;

static void taps_free(Taps *taps) {
  free(taps->first);
  free(taps->weights);
}

static int taps_make(Taps *taps, int length, int target_length) {
  const double scale = (double)length / target_length;
  // When shrinking, the filter widens by the scale, so that every source sample counts.
  const double width = scale > 1 ? scale : 1;
  taps->count = (int)ceil(6 * width) + 1;
  taps->first = malloc((size_t)target_length * sizeof(int));
  taps->weights = malloc((size_t)target_length * taps->count * sizeof(float));
  if (!taps->first || !taps->weights) {
    taps_free(taps);
    return -1;
  }
  for (int t = 0; t < target_length; t++) {
    const double centre = (t + 0.5) * scale - 0.5;
    const int first = (int)ceil(centre - 3 * width);
    double total = 0;
    for (int k = 0; k < taps->count; k++) total += lanczos3((first + k - centre) / width);
    for (int k = 0; k < taps->count; k++)
      taps->weights[(size_t)t * taps->count + k] = (float)(lanczos3((first + k - centre) / width) / total);
    taps->first[t] = first;
  }
  return 0;
}

/**
 * Resizes premultiplied RGBA `source` (width x height, in rows of `row_pixels` pixels) to `target` (target_width x
 * target_height) with a Lanczos filter, and then sharpens it: the difference between each pixel and the average of
 * it and its eight neighbours (weighted 1 2 1 across and down) is added back, SHARPENING times. Both keep lines
 * and edges crisper than averaging the covered area does, at the price of a faint halo beside a hard edge. In a
 * blind comparison on real drawn video stickers this looked best every time. Returns 0, or -1 without memory.
 */
static int resize_sharp(const uint8_t *source, int row_pixels, int width, int height, uint8_t *target,
                        int target_width, int target_height) {
  Taps across = {0}, down = {0};
  float *rows = malloc((size_t)target_width * height * 4 * sizeof(float));
  float *fitted = malloc((size_t)target_width * target_height * 4 * sizeof(float));
  if (!rows || !fitted || taps_make(&across, width, target_width) < 0 || taps_make(&down, height, target_height) < 0) {
    free(rows);
    free(fitted);
    taps_free(&across);
    taps_free(&down);
    return -1;
  }
  for (int y = 0; y < height; y++) {
    const uint8_t *line = source + (size_t)y * row_pixels * 4;
    for (int t = 0; t < target_width; t++) {
      const float *weights = across.weights + (size_t)t * across.count;
      float sum[4] = {0, 0, 0, 0};
      for (int k = 0; k < across.count; k++) {
        const int s = across.first[t] + k;
        const uint8_t *pixel = line + (size_t)(s < 0 ? 0 : s >= width ? width - 1 : s) * 4;
        for (int c = 0; c < 4; c++) sum[c] += weights[k] * pixel[c];
      }
      memcpy(rows + ((size_t)y * target_width + t) * 4, sum, sizeof sum);
    }
  }
  for (int t = 0; t < target_height; t++) {
    const float *weights = down.weights + (size_t)t * down.count;
    for (int x = 0; x < target_width; x++) {
      float sum[4] = {0, 0, 0, 0};
      for (int k = 0; k < down.count; k++) {
        const int s = down.first[t] + k;
        const float *pixel = rows + ((size_t)(s < 0 ? 0 : s >= height ? height - 1 : s) * target_width + x) * 4;
        for (int c = 0; c < 4; c++) sum[c] += weights[k] * pixel[c];
      }
      memcpy(fitted + ((size_t)t * target_width + x) * 4, sum, sizeof sum);
    }
  }
  static const int blur[3] = {1, 2, 1};
  for (int y = 0; y < target_height; y++) {
    for (int x = 0; x < target_width; x++) {
      for (int c = 0; c < 4; c++) {
        double blurred = 0;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            const int ny = y + dy < 0 ? 0 : y + dy >= target_height ? target_height - 1 : y + dy;
            const int nx = x + dx < 0 ? 0 : x + dx >= target_width ? target_width - 1 : x + dx;
            blurred += blur[dy + 1] * blur[dx + 1] * fitted[((size_t)ny * target_width + nx) * 4 + c];
          }
        }
        const double value = fitted[((size_t)y * target_width + x) * 4 + c];
        const long rounded = lround(value + SHARPENING * (value - blurred / 16));
        target[((size_t)y * target_width + x) * 4 + c] = (uint8_t)(rounded < 0 ? 0 : rounded > 255 ? 255 : rounded);
      }
    }
  }
  free(rows);
  free(fitted);
  taps_free(&across);
  taps_free(&down);
  return 0;
}

/** swscale's colour coefficients for the frame's colour space. */
static const int *coefficients(enum AVColorSpace space) {
  switch (space) {
    case AVCOL_SPC_BT709:
      return sws_getCoefficients(SWS_CS_ITU709);
    case AVCOL_SPC_BT2020_NCL:
    case AVCOL_SPC_BT2020_CL:
      return sws_getCoefficients(SWS_CS_BT2020);
    default:
      return sws_getCoefficients(SWS_CS_ITU601);
  }
}

/** Draws the decoded frame into `square` (size x size RGBA): scaled to fit, centred, transparent around it. */
static int draw_frame(const AVFrame *frame, int size, uint8_t *square, struct SwsContext **converter) {
  const int width = frame->width, height = frame->height;
  // swscale's direct conversion writes pixels two at a time and leaves the last column of an odd width unwritten.
  // Such a frame is converted one column wider, which the rows of a decoded frame have room for, and the extra
  // column is not used. Each row of `rgba` is `converted` pixels long.
  const int converted = frame->linesize[0] > width ? width + (width & 1) : width;
  // At the same size, swscale converts directly, each colour sample covering its 2 x 2 pixels. Interpolating the
  // colour samples instead would blend the colour of transparent pixels into the edges of what is visible.
  *converter = sws_getCachedContext(*converter, converted, height, frame->format, converted, height,
                                    AV_PIX_FMT_RGBA, SWS_POINT, NULL, NULL, NULL);
  if (!*converter) return fail("the video's pixel format cannot be converted", 0);
  sws_setColorspaceDetails(*converter, coefficients(frame->colorspace), frame->color_range == AVCOL_RANGE_JPEG,
                           sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16, 1 << 16);
  // Zeroed, so that a pixel swscale does not write is transparent and the same on every run.
  uint8_t *rgba = calloc((size_t)converted * height, 4);
  if (!rgba) return fail("out of memory", AVERROR(ENOMEM));
  uint8_t *planes[4] = {rgba, NULL, NULL, NULL};
  int strides[4] = {converted * 4, 0, 0, 0};
  sws_scale(*converter, (const uint8_t *const *)frame->data, frame->linesize, 0, height, planes, strides);
  // A frame without a transparency channel converts to opaque pixels.
  for (size_t i = 0; i < (size_t)converted * height; i++) {
    uint8_t *pixel = rgba + i * 4;
    for (int c = 0; c < 3; c++) pixel[c] = (uint8_t)((pixel[c] * pixel[3] + 127) / 255);
  }
  const int largest = width > height ? width : height;
  int fit_width = (int)lround((double)width * size / largest), fit_height = (int)lround((double)height * size / largest);
  if (fit_width < 1) fit_width = 1;
  if (fit_height < 1) fit_height = 1;
  uint8_t *fitted = malloc((size_t)fit_width * fit_height * 4);
  if (!fitted) {
    free(rgba);
    return fail("out of memory", AVERROR(ENOMEM));
  }
  if (fit_width == width && fit_height == height) {
    // At the video's own size nothing is scaled.
    for (int y = 0; y < height; y++)
      memcpy(fitted + (size_t)y * width * 4, rgba + (size_t)y * converted * 4, (size_t)width * 4);
  } else if (resize_sharp(rgba, converted, width, height, fitted, fit_width, fit_height) < 0) {
    free(rgba);
    free(fitted);
    return fail("out of memory", AVERROR(ENOMEM));
  }
  free(rgba);
  memset(square, 0, (size_t)size * size * 4);
  const int left = (size - fit_width) / 2, top = (size - fit_height) / 2;
  for (int y = 0; y < fit_height; y++) {
    for (int x = 0; x < fit_width; x++) {
      const uint8_t *from = fitted + ((size_t)y * fit_width + x) * 4;
      uint8_t *to = square + ((size_t)(top + y) * size + left + x) * 4;
      const int alpha = from[3];
      if (alpha == 0) continue;
      for (int c = 0; c < 3; c++) {
        int value = (from[c] * 255 + alpha / 2) / alpha;
        to[c] = (uint8_t)(value > 255 ? 255 : value);
      }
      to[3] = (uint8_t)alpha;
    }
  }
  free(fitted);
  return 0;
}

/**
 * Writes `count` frames of size x size RGBA into `out`: frame k is the video frame showing at k / frame_rate
 * seconds. Returns the number of frames written, or a negative error (webm_error says why).
 */
EMSCRIPTEN_KEEPALIVE int webm_render(const uint8_t *data, int data_size, int size, double frame_rate, int count,
                                     uint8_t *out) {
  const size_t frame_bytes = (size_t)size * size * 4;
  uint8_t *shown = malloc(frame_bytes);
  if (!shown) return fail("out of memory", AVERROR(ENOMEM));
  struct SwsContext *converter = NULL;
  Video video;
  int code = video_open(&video, data, data_size);
  int written = 0, have_shown = 0;
  double first = NAN;
  while (code >= 0 && written < count) {
    code = next_frame(&video);
    if (code == AVERROR_EOF) break;
    if (code < 0) {
      fail("the video cannot be decoded", code);
      break;
    }
    double time = frame_time(&video);
    if (isnan(first)) first = time;
    time = isnan(time) ? INFINITY : time - first;
    // The output frames before this frame's time show the frame before it.
    if (have_shown)
      while (written < count && written / frame_rate < time - 1e-6)
        memcpy(out + written++ * frame_bytes, shown, frame_bytes);
    code = draw_frame(video.frame, size, shown, &converter);
    have_shown = code >= 0;
  }
  if (code >= 0 || code == AVERROR_EOF) {
    if (!have_shown) {
      code = fail("the video has no frames", 0);
    } else {
      // The last frame shows until the end.
      while (written < count) memcpy(out + written++ * frame_bytes, shown, frame_bytes);
      code = written;
    }
  }
  sws_freeContext(converter);
  video_close(&video);
  free(shown);
  return code;
}
