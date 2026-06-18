// Element registry. Everything hangs off the global PG namespace.
window.PG = {};

// Element ids (0 = empty). Order here is also sidebar order.
PG.E = {
  EMPTY: 0,
  POWDER: 1, WATER: 2, FIRE: 3, SEED: 4, GPOWDER: 5, FAN: 6,
  ICE: 7, SNOW: 8, GAS: 9, CLONE: 10, SALT: 11, SALTWATER: 12,
  OIL: 13, THUNDER: 14, SPARK: 15, NITRO: 16, C4: 17, STONE: 18,
  MAGMA: 19, VIRUS: 20, SOAPY: 21, PUMP: 22, MERCURY: 23, ACID: 24,
  VINE: 25, WOOD: 26, FUSE: 27, LASER: 28, CLOUD: 29, ANT: 30,
  TORCH: 31, BIRD: 32, FISH: 33, METAL: 34, BOMB: 35, BUBBLE: 36,
  STEAM: 37, GLASS: 38, FIREWORK: 39, BLOCK: 40,
};

// states: powder | liquid | gas | static | energy | life
// density: heavier sinks below lighter (liquids/powders vs liquids)
// burn: 0 = no, otherwise chance/255 that adjacent fire ignites it
PG.elements = [];
(function () {
  const E = PG.E;
  function def(id, name, color, state, opts) {
    PG.elements[id] = Object.assign({
      id, name, color, state,
      density: 100, burn: 0, hidden: false,
    }, opts || {});
  }
  def(E.EMPTY,    "erase",  "#000000", "static", { hidden: true });
  def(E.POWDER,   "powder", "#e0c080", "powder", { density: 150 });
  def(E.WATER,    "water",  "#3060ff", "liquid", { density: 100 });
  def(E.FIRE,     "fire",   "#ff6020", "energy");
  def(E.SEED,     "seed",   "#80c020", "powder", { density: 120, burn: 90 });
  def(E.GPOWDER,  "g-powder","#909098","powder", { density: 140, burn: 255 });
  def(E.FAN,      "fan",    "#8090b0", "static");
  def(E.ICE,      "ice",    "#a0d8f0", "static");
  def(E.SNOW,     "snow",   "#f0f6ff", "powder", { density: 60 });
  def(E.GAS,      "gas",    "#60a060", "gas",    { burn: 255 });
  def(E.CLONE,    "clone",  "#c0b040", "static");
  def(E.SALT,     "salt",   "#f8f8f0", "powder", { density: 145 });
  def(E.SALTWATER,"saltwater","#4080e0","liquid",{ density: 105 });
  def(E.OIL,      "oil",    "#806030", "liquid", { density: 80, burn: 120 });
  def(E.THUNDER,  "thunder","#ffff60", "energy");
  def(E.SPARK,    "spark",  "#ffe080", "energy");
  def(E.NITRO,    "nitro",  "#40c040", "liquid", { density: 90, burn: 255 });
  def(E.C4,       "c-4",    "#f0e0a0", "static", { burn: 255 });
  def(E.STONE,    "stone",  "#9a9a9a", "powder", { density: 200 });
  def(E.MAGMA,    "magma",  "#ff4000", "liquid", { density: 180 });
  def(E.VIRUS,    "virus",  "#e040e0", "energy");
  def(E.SOAPY,    "soapy",  "#80d0d0", "liquid", { density: 95 });
  def(E.PUMP,     "pump",   "#406080", "static");
  def(E.MERCURY,  "mercury","#c8ccd8", "liquid", { density: 250 });
  def(E.ACID,     "acid",   "#c0f000", "liquid", { density: 102 });
  def(E.VINE,     "vine",   "#30a030", "static", { burn: 90 });
  def(E.WOOD,     "wood",   "#a07040", "static", { burn: 25 });
  def(E.FUSE,     "fuse",   "#d0a060", "static", { burn: 12 });
  def(E.LASER,    "laser",  "#ff40ff", "energy");
  def(E.CLOUD,    "cloud",  "#e8ecf4", "static");
  def(E.ANT,      "ant",    "#603020", "life",   { density: 130 });
  def(E.TORCH,    "torch",  "#ff9040", "static");
  def(E.BIRD,     "bird",   "#f0f000", "life");
  def(E.FISH,     "fish",   "#f08030", "life",   { density: 101 });
  def(E.METAL,    "metal",  "#708090", "static");
  def(E.BOMB,     "bomb",   "#303038", "powder", { density: 160 });
  def(E.BUBBLE,   "bubble", "#a0c0e0", "gas");
  def(E.STEAM,    "steam",  "#b0b8c8", "gas");
  def(E.GLASS,    "glass",  "#c0d8e0", "static");
  def(E.FIREWORK, "firework","#ff80c0","energy");
  def(E.BLOCK,    "block",  "#606060", "static", { hidden: true });
})();

// Elements shown in the sidebar palette, in order.
PG.paletteOrder = [
  PG.E.POWDER, PG.E.WATER, PG.E.FIRE, PG.E.SEED, PG.E.GPOWDER, PG.E.FAN,
  PG.E.ICE, PG.E.SNOW, PG.E.GAS, PG.E.CLONE, PG.E.SALT, PG.E.SALTWATER,
  PG.E.OIL, PG.E.THUNDER, PG.E.SPARK, PG.E.NITRO, PG.E.C4, PG.E.STONE,
  PG.E.MAGMA, PG.E.VIRUS, PG.E.SOAPY, PG.E.PUMP, PG.E.MERCURY, PG.E.ACID,
  PG.E.VINE, PG.E.WOOD, PG.E.FUSE, PG.E.LASER, PG.E.CLOUD, PG.E.ANT,
  PG.E.TORCH, PG.E.BIRD, PG.E.FISH, PG.E.METAL, PG.E.BOMB, PG.E.BUBBLE,
  PG.E.STEAM, PG.E.GLASS, PG.E.FIREWORK,
];

// Precomputed ABGR pixel colors, 4 shade variants per element.
PG.colorVariants = [];
(function () {
  function hexToAbgr(hex, mul) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, Math.round(r * mul));
    g = Math.min(255, Math.round(g * mul));
    b = Math.min(255, Math.round(b * mul));
    return (255 << 24) | (b << 16) | (g << 8) | r;
  }
  for (let id = 0; id < PG.elements.length; id++) {
    const el = PG.elements[id];
    if (!el) continue;
    PG.colorVariants[id] = [
      hexToAbgr(el.color, 1.0), hexToAbgr(el.color, 0.88),
      hexToAbgr(el.color, 0.94), hexToAbgr(el.color, 1.08),
    ];
  }
  // Fire/laser/thunder get brighter variants for flicker.
  PG.fireColors = ["#fff0a0", "#ffc040", "#ff8020", "#ff4010", "#c02000"]
    .map(h => hexToAbgr(h, 1));
  // Firework spark palette (variant stored in cell life low bits).
  PG.fireworkColors = ["#ff4060", "#40ff80", "#4080ff", "#ffe040", "#ff40ff", "#40ffff"]
    .map(h => hexToAbgr(h, 1));
  PG.hexToAbgr = hexToAbgr;
})();
