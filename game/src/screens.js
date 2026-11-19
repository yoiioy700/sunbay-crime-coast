// The two screens over the world: the title card, and the pause menu Esc opens. Both are DOM,
// so the type is crisp at any window size and nothing is rasterised into the canvas. The title
// names the city, what the game is, the controls, and the one thing that starts a run: PLAY.

const TITLE = 'SUNBAY';
const STORY = 'Crime Coast';

const CONTROLS = [
  ['WASD', 'Walk · drive'],
  ['SHIFT', 'Sprint'],
  ['SPACE', 'Jump · handbrake'],
  ['E', 'Enter · exit a car'],
  ['H', 'Honk'],
  ['MOUSE', 'Look around'],
  ['WHEEL', 'Camera distance'],
  ['ESC', 'Pause'],
];

function el(tag, style, html) {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

export function createScreens(root, { onPlay, onResume, onQuit }) {
  root.innerHTML = '';

  // -- title card ---------------------------------------------------------------------------
  const title = el(
    'section',
    [
      'position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;',
      'padding:0 clamp(24px, 7vw, 110px) clamp(28px, 7vh, 84px);',
      'background:linear-gradient(180deg, rgba(5,16,23,0.30) 0%, rgba(5,16,23,0.06) 38%, rgba(5,16,23,0.82) 100%);',
      'color:#fff4e2;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;',
      'pointer-events:auto;',
    ].join(''),
  );
  const titleInner = el('div', 'max-width:760px;');
  titleInner.append(
    el(
      'div',
      'font-size:clamp(10px,1.1vw,13px);letter-spacing:0.52em;color:#ffcf92;margin-bottom:10px;',
      'A COASTAL CITY · A CRIME STORY',
    ),
    el(
      'h1',
      'margin:0;font-size:clamp(58px,10vw,132px);line-height:0.88;font-weight:900;letter-spacing:-0.035em;' +
        'text-shadow:0 10px 40px rgba(0,0,0,0.45);',
      `${TITLE}: <span style="color:#ffcf92;font-weight:600;letter-spacing:-0.02em;font-size:0.52em">${STORY}</span>`,
    ),
    el(
      'p',
      'margin:18px 0 0;max-width:520px;font-size:clamp(13px,1.25vw,16px);line-height:1.6;color:rgba(255,244,226,0.78);',
      'Palm shade, hot asphalt and a city that never asks where the money came from. ' +
        'Come up on the coast, find your feet, and learn the streets.',
    ),
  );

  const controlsRow = el('div', 'display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 0;max-width:640px;');
  for (const [key, action] of CONTROLS) {
    const chip = el(
      'div',
      'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid rgba(255,244,226,0.22);' +
        'border-radius:6px;background:rgba(9,20,27,0.5);font-size:11px;letter-spacing:0.08em;',
    );
    chip.append(
      el('span', 'color:#ffcf92;font-weight:700;letter-spacing:0.14em', key),
      el('span', 'color:rgba(255,244,226,0.68)', action),
    );
    controlsRow.append(chip);
  }
  titleInner.append(controlsRow);

  const playRow = el('div', 'display:flex;align-items:center;gap:20px;margin-top:30px;');
  const playButton = el(
    'button',
    [
      'appearance:none;border:0;cursor:pointer;padding:16px 54px;border-radius:5px;',
      'background:linear-gradient(180deg,#ffd9a0,#f2b25f);color:#20160c;',
      'font:800 16px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:0.34em;',
      'box-shadow:0 10px 26px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.5);',
      'transition:transform 0.12s ease, box-shadow 0.12s ease;',
    ].join(''),
    'PLAY',
  );
  playButton.type = 'button';
  playButton.addEventListener('mouseenter', () => {
    playButton.style.transform = 'translateY(-2px)';
    playButton.style.boxShadow = '0 14px 32px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.5)';
  });
  playButton.addEventListener('mouseleave', () => {
    playButton.style.transform = 'translateY(0)';
    playButton.style.boxShadow = '0 10px 26px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.5)';
  });
  playButton.addEventListener('click', () => onPlay());
  playRow.append(
    playButton,
    el('div', 'font-size:11px;letter-spacing:0.16em;color:rgba(255,244,226,0.5)', 'CLICK TO ENTER THE CITY'),
  );
  titleInner.append(playRow);
  title.append(titleInner);

  // -- pause menu ---------------------------------------------------------------------------
  const pause = el(
    'section',
    [
      'position:absolute;inset:0;display:none;place-items:center;pointer-events:auto;',
      'background:rgba(4,12,18,0.58);backdrop-filter:blur(6px);',
      'font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#fff4e2;',
    ].join(''),
  );
  const pausePanel = el(
    'div',
    'width:min(400px,86vw);padding:34px 34px 30px;border-radius:10px;border:1px solid rgba(255,244,226,0.18);' +
      'background:linear-gradient(160deg,rgba(18,42,55,0.96),rgba(8,20,27,0.97));box-shadow:0 30px 70px rgba(0,0,0,0.5);',
  );
  pausePanel.append(
    el('div', 'font-size:10px;letter-spacing:0.5em;color:#ffcf92', 'SUNBAY: CRIME COAST'),
    el('h2', 'margin:10px 0 24px;font-size:38px;font-weight:900;letter-spacing:-0.02em', 'PAUSED'),
  );
  const resumeButton = el(
    'button',
    'appearance:none;border:0;width:100%;cursor:pointer;padding:14px;border-radius:5px;' +
      'background:linear-gradient(180deg,#ffd9a0,#f2b25f);color:#20160c;font:800 13px/1 ui-sans-serif,system-ui,sans-serif;' +
      'letter-spacing:0.3em;',
    'RESUME',
  );
  resumeButton.type = 'button';
  resumeButton.addEventListener('click', () => onResume());
  const quitButton = el(
    'button',
    'appearance:none;margin-top:10px;width:100%;cursor:pointer;padding:13px;border-radius:5px;' +
      'background:transparent;border:1px solid rgba(255,244,226,0.24);color:rgba(255,244,226,0.82);' +
      'font:700 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:0.26em;',
    'BACK TO TITLE',
  );
  quitButton.type = 'button';
  quitButton.addEventListener('click', () => onQuit());
  pausePanel.append(
    resumeButton,
    quitButton,
    el(
      'div',
      'margin-top:22px;padding-top:16px;border-top:1px solid rgba(255,244,226,0.12);' +
        'font-size:11px;line-height:1.8;color:rgba(255,244,226,0.55);letter-spacing:0.04em;',
      'Esc resumes · E enters a car · H honks<br>Shift sprints · Space jumps or slides the car',
    ),
  );
  pause.append(pausePanel);

  root.append(title, pause);

  function showTitle() {
    title.style.display = 'flex';
    pause.style.display = 'none';
  }

  function hideTitle() {
    title.style.display = 'none';
  }

  function showPause() {
    pause.style.display = 'grid';
  }

  function hidePause() {
    pause.style.display = 'none';
  }

  function hideAll() {
    title.style.display = 'none';
    pause.style.display = 'none';
  }

  return {
    showTitle,
    hideTitle,
    showPause,
    hidePause,
    hideAll,
    isTitleVisible: () => title.style.display !== 'none',
    isPauseVisible: () => pause.style.display !== 'none',
    playButton,
  };
}
