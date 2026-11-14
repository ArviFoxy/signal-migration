// The script of the page that choices.mjs writes: choosing a tile, and playing the tiles of one sticker in step.

// What is chosen, as { sticker: choice }, kept by the server that serves this page.
let selections = {};
const tiles = [...document.querySelectorAll('figure[data-sticker]')];
const stickers = new Set(tiles.map((tile) => tile.dataset.sticker));
function show() {
  for (const tile of tiles) {
    tile.setAttribute('aria-pressed', String(selections[tile.dataset.sticker] === tile.dataset.choice));
  }
  const count = Object.keys(selections).length;
  document.getElementById('chosen').textContent = count + ' of ' + stickers.size + ' chosen';
}
async function choose(tile) {
  const { sticker, choice } = tile.dataset;
  if (selections[sticker] === choice) delete selections[sticker];
  else selections[sticker] = choice;
  show();
  const response = await fetch('selections', { method: 'POST', body: JSON.stringify(selections) });
  if (!response.ok) document.getElementById('chosen').textContent = 'Not saved: the server answered ' + response.status;
}
for (const tile of tiles) {
  tile.addEventListener('click', () => choose(tile));
  tile.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choose(tile);
  });
}
fetch('selections.json')
  .then((response) => (response.ok ? response.json() : {}))
  .then((kept) => {
    selections = kept;
    show();
  });

// A browser starts an animated picture when it first shows it, so the tiles of a sticker would each run from the
// moment they happened to load. To play them in step, every tile of a row is replaced at the same instant by a new
// picture of the same file, held in memory, once for each pass of the animation (the row's data-period, in
// milliseconds). The new pictures are decoded before that instant, so that none starts late. Only rows near the
// screen are played this way.
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const DECODING_TIME_MS = 400;
const nearScreen = new Set();
const watcher = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) nearScreen.add(entry.target);
      else nearScreen.delete(entry.target);
    }
  },
  { rootMargin: '300px' },
);
async function playInStep(row) {
  const period = Number(row.dataset.period);
  let files = null;
  let startedAt = -Infinity;
  for (;;) {
    if (!nearScreen.has(row)) {
      await pause(250);
      continue;
    }
    await pause(startedAt + period - DECODING_TIME_MS - performance.now());
    const shown = [...row.querySelectorAll('img')];
    files ??= await Promise.all(shown.map(async (image) => (await fetch(image.src)).blob()));
    const fresh = await Promise.all(
      files.map(async (file) => {
        const image = new Image();
        image.alt = '';
        image.src = URL.createObjectURL(file);
        await image.decode().catch(() => undefined);
        return image;
      }),
    );
    await pause(startedAt + period - performance.now());
    await nextFrame();
    shown.forEach((image, i) => {
      image.replaceWith(fresh[i]);
      if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
    });
    startedAt = performance.now();
  }
}
for (const row of document.querySelectorAll('.row[data-period]')) {
  watcher.observe(row);
  void playInStep(row);
}
