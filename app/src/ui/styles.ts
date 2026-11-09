// Styles shared by the app's elements. Colours are custom properties set on the page (public/index.html), with
// a dark variant.

import { css } from 'lit';

export const shared = css`
  :host {
    color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
  }
  h1,
  h2 {
    margin: 0;
    line-height: 1.25;
  }
  h1 {
    font-size: 24px;
  }
  h2 {
    font-size: 18px;
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--error);
  }
  button {
    min-height: 40px;
    padding: 0 18px;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button.secondary {
    background: transparent;
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  button.small {
    min-height: 30px;
    padding: 0 12px;
    font-size: 13px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  input {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  .card {
    padding: 16px;
    border-radius: 12px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  img.qr {
    width: 240px;
    height: 240px;
    border-radius: 8px;
    background: #fff;
    padding: 8px;
  }
  progress {
    width: 100%;
    height: 8px;
    accent-color: var(--accent);
  }
`;
