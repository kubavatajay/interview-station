/* Original, text-free illustrations for each situation. Simple shapes, gentle motion. */
(function () {
  const C = { paper: '#f5f2ec', wall: '#e9e3d8', floor: '#ddd5c7', teal: '#0f5a5e', tealSoft: '#7fa9a6', gold: '#c99a45', ink: '#33464f', skin1: '#d9a582', skin2: '#9c6b4e', skin3: '#e8c3a3', cloth1: '#3d6f8f', cloth2: '#8a5a6b', cloth3: '#5d7c5a', white: '#ffffff', glass: '#bcd3d6', red: '#c0574a' };
  const style = `
  <style>
    .sc-blink { animation: scBlink 1.4s steps(2, start) infinite; }
    .sc-float { animation: scFloat 4s ease-in-out infinite; }
    .sc-ring { animation: scRing 1.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
    .sc-pulse { animation: scPulse 1.8s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
    .sc-hand { animation: scHand 3.2s ease-in-out infinite; transform-origin: bottom center; transform-box: fill-box; }
    .sc-tick { animation: scTick 6s linear infinite; transform-origin: 0 0; }
    @keyframes scBlink { to { visibility: hidden; } }
    @keyframes scFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
    @keyframes scRing { 0%,100% { transform: rotate(0); } 10% { transform: rotate(-9deg); } 20% { transform: rotate(9deg); } 30% { transform: rotate(-6deg); } 40% { transform: rotate(0); } }
    @keyframes scPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: .75; } }
    @keyframes scHand { 0%,15% { transform: rotate(0); } 35%,85% { transform: rotate(-8deg) translateY(-6px); } 100% { transform: rotate(0); } }
    @keyframes scTick { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .sc-blink,.sc-float,.sc-ring,.sc-pulse,.sc-hand,.sc-tick { animation: none; } }
  </style>`;

  function person(x, y, skin, cloth, s) {
    s = s || 1;
    return `<g transform="translate(${x} ${y}) scale(${s})">
      <path d="M-34 70 Q-34 22 0 22 Q34 22 34 70 Z" fill="${cloth}"/>
      <circle cx="0" cy="0" r="20" fill="${skin}"/>
      <path d="M-20 -4 Q-18 -24 0 -24 Q18 -24 20 -4 Q10 -14 0 -13 Q-10 -14 -20 -4Z" fill="${C.ink}" opacity=".85"/>
    </g>`;
  }

  const scenes = {
    /* Situation 1: late evening, a shared presentation with one section unfinished */
    presentation: `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">${style}
      <rect width="640" height="360" fill="${C.wall}"/>
      <rect y="268" width="640" height="92" fill="${C.floor}"/>
      <rect x="452" y="38" width="148" height="112" rx="6" fill="#1d3a4a"/>
      <circle cx="560" cy="74" r="16" fill="#f2e6c8"/><circle cx="552" cy="68" r="16" fill="#1d3a4a"/>
      <circle cx="486" cy="60" r="2" fill="#f2e6c8"/><circle cx="512" cy="112" r="1.6" fill="#f2e6c8"/><circle cx="584" cy="122" r="1.8" fill="#f2e6c8"/>
      <g transform="translate(92 54)"><circle r="26" fill="${C.white}" stroke="${C.ink}" stroke-width="3"/>
        <line x1="0" y1="0" x2="0" y2="-16" stroke="${C.ink}" stroke-width="3" stroke-linecap="round" transform="rotate(300)"/>
        <line class="sc-tick" x1="0" y1="0" x2="0" y2="-20" stroke="${C.red}" stroke-width="2" stroke-linecap="round"/></g>
      <rect x="150" y="228" width="340" height="14" rx="4" fill="#8b6b4a"/>
      <rect x="166" y="242" width="10" height="70" fill="#7a5c3e"/><rect x="464" y="242" width="10" height="70" fill="#7a5c3e"/>
      <g transform="translate(232 128)">
        <rect width="176" height="100" rx="8" fill="${C.ink}"/>
        <rect x="8" y="8" width="160" height="84" rx="4" fill="${C.white}"/>
        <rect x="18" y="18" width="62" height="8" rx="3" fill="${C.teal}"/>
        <rect x="18" y="34" width="62" height="5" rx="2" fill="${C.tealSoft}"/><rect x="18" y="44" width="54" height="5" rx="2" fill="${C.tealSoft}"/>
        <rect x="18" y="54" width="58" height="5" rx="2" fill="${C.tealSoft}"/>
        <rect x="90" y="18" width="68" height="64" rx="4" fill="none" stroke="${C.gold}" stroke-width="2.5" stroke-dasharray="6 5"/>
        <rect class="sc-blink" x="100" y="30" width="3" height="14" fill="${C.gold}"/>
      </g>
      <path d="M220 228 L420 228 L432 236 L208 236 Z" fill="#596b74"/>
      ${person(250, 248, C.skin1, C.cloth1, 1.05)}
      <g class="sc-float">${person(500, 236, C.skin2, C.cloth2, 1.15)}</g>
      <rect x="520" y="268" width="0" height="0"/>
    </svg>`,

    /* Situation 2: a presentation to faculty; a question from the audience */
    seminar: `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">${style}
      <rect width="640" height="360" fill="${C.wall}"/>
      <rect y="280" width="640" height="80" fill="${C.floor}"/>
      <rect x="196" y="34" width="248" height="140" rx="8" fill="${C.white}" stroke="#c9c0b1" stroke-width="3"/>
      <rect x="220" y="56" width="90" height="10" rx="3" fill="${C.teal}"/>
      <rect x="224" y="140" width="22" height="20" fill="${C.tealSoft}"/><rect x="256" y="118" width="22" height="42" fill="${C.teal}"/>
      <rect x="288" y="100" width="22" height="60" fill="${C.tealSoft}"/><rect x="320" y="86" width="22" height="74" fill="${C.gold}"/>
      <rect x="360" y="84" width="64" height="6" rx="3" fill="#c9c0b1"/><rect x="360" y="98" width="52" height="6" rx="3" fill="#c9c0b1"/><rect x="360" y="112" width="58" height="6" rx="3" fill="#c9c0b1"/>
      <rect x="452" y="164" width="70" height="116" rx="6" fill="#8b6b4a"/>
      ${person(487, 136, C.skin3, C.cloth3, 1.05)}
      <g transform="translate(0 0)">
        ${person(110, 268, C.skin2, C.cloth1, 1.05)}
        ${person(210, 274, C.skin1, '#6f7f86', 1.0)}
        <g class="sc-hand"><rect x="290" y="196" width="10" height="46" rx="5" fill="${C.skin1}"/><circle cx="295" cy="194" r="8" fill="${C.skin1}"/></g>
        ${person(318, 268, '#c48e6a', C.cloth2, 1.05)}
      </g>
      <rect x="60" y="318" width="330" height="12" rx="5" fill="#7a5c3e"/>
    </svg>`,

    /* Situation 3: thirty minutes, a phone waiting, a teammate, an open record */
    clinic: `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">${style}
      <rect width="640" height="360" fill="${C.wall}"/>
      <rect y="270" width="640" height="90" fill="${C.floor}"/>
      <g transform="translate(320 70)"><circle r="40" fill="${C.white}" stroke="${C.ink}" stroke-width="3"/>
        <path d="M0 0 L0 -36 A36 36 0 0 1 0 36 Z" fill="${C.gold}" opacity=".35"/>
        <line x1="0" y1="0" x2="0" y2="-26" stroke="${C.ink}" stroke-width="3.5" stroke-linecap="round"/>
        <line class="sc-tick" x1="0" y1="0" x2="0" y2="-32" stroke="${C.red}" stroke-width="2" stroke-linecap="round"/>
        <circle r="4" fill="${C.ink}"/></g>
      <rect x="90" y="214" width="460" height="14" rx="4" fill="#8b6b4a"/>
      <rect x="106" y="228" width="10" height="70" fill="#7a5c3e"/><rect x="524" y="228" width="10" height="70" fill="#7a5c3e"/>
      <g class="sc-ring" transform="translate(150 182)"><rect width="56" height="32" rx="8" fill="${C.ink}"/><rect x="8" y="-8" width="40" height="12" rx="6" fill="${C.ink}"/>
        <circle cx="28" cy="16" r="7" fill="${C.tealSoft}"/></g>
      <path d="M140 170 q-8 -8 0 -16 M132 174 q-14 -12 0 -26" stroke="${C.teal}" stroke-width="3" fill="none" stroke-linecap="round" class="sc-blink"/>
      <g transform="translate(262 162)"><rect width="96" height="52" rx="4" fill="${C.white}" stroke="#c9c0b1" stroke-width="2"/>
        <rect x="10" y="10" width="60" height="5" rx="2" fill="#c9c0b1"/><rect x="10" y="22" width="70" height="5" rx="2" fill="#c9c0b1"/>
        <rect x="10" y="34" width="40" height="5" rx="2" fill="${C.gold}"/>
        <circle class="sc-pulse" cx="84" cy="36" r="7" fill="${C.gold}"/></g>
      ${person(470, 220, C.skin3, C.cloth3, 1.0)}
      <g class="sc-float"><rect x="410" y="150" width="38" height="28" rx="6" fill="${C.white}" stroke="#c9c0b1" stroke-width="2"/><circle cx="420" cy="164" r="3" fill="${C.ink}"/><circle cx="429" cy="164" r="3" fill="${C.ink}"/><circle cx="438" cy="164" r="3" fill="${C.ink}"/></g>
    </svg>`,

    /* Situation 4: a value in a table flagged by an automated check */
    computer: `<svg viewBox="0 0 640 360" xmlns="http://www.w3.org/2000/svg">${style}
      <rect width="640" height="360" fill="${C.wall}"/>
      <rect y="278" width="640" height="82" fill="${C.floor}"/>
      <rect x="140" y="262" width="360" height="14" rx="4" fill="#8b6b4a"/>
      <rect x="300" y="226" width="40" height="36" fill="#596b74"/><rect x="264" y="256" width="112" height="8" rx="4" fill="#596b74"/>
      <g transform="translate(170 46)">
        <rect width="300" height="182" rx="10" fill="${C.ink}"/>
        <rect x="10" y="10" width="280" height="162" rx="5" fill="${C.white}"/>
        <rect x="26" y="24" width="90" height="8" rx="3" fill="${C.teal}"/>
        <g fill="#d8d1c4">
          <rect x="26" y="46" width="248" height="16" rx="3"/><rect x="26" y="70" width="248" height="16" rx="3"/>
          <rect x="26" y="118" width="248" height="16" rx="3"/><rect x="26" y="142" width="248" height="16" rx="3"/>
        </g>
        <rect x="26" y="94" width="248" height="16" rx="3" fill="#f6e3c0"/>
        <rect x="200" y="98" width="40" height="8" rx="3" fill="${C.gold}"/>
        <g class="sc-pulse"><line x1="256" y1="92" x2="256" y2="116" stroke="${C.red}" stroke-width="3" stroke-linecap="round"/><path d="M257 92 L272 97 L257 103 Z" fill="${C.red}"/></g>
      </g>
      ${person(120, 250, C.skin2, C.cloth1, 1.0)}
    </svg>`
  };
  window.SCENES = scenes;
})();
