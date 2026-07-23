'use strict';

// --- Village: buildings are anchored as % coordinates over village-map.jpg ---
const VILLAGE_BUILDINGS = {
  townhall: { label: 'Town Hall', x: 48, y: 41, seats: [{ x: 48, y: 44 }, { x: 45, y: 44 }, { x: 51, y: 44 }] },
  library: { label: 'Library', x: 23, y: 24, seats: [{ x: 23, y: 27 }, { x: 20, y: 27 }] },
  castle: { label: 'Castle', x: 48, y: 19, seats: [{ x: 48, y: 22 }, { x: 45, y: 22 }] },
  observatory: { label: 'Observatory', x: 69, y: 17, seats: [{ x: 69, y: 20 }] },
  magetower: { label: 'Mage Tower', x: 80, y: 30, seats: [{ x: 80, y: 33 }, { x: 77, y: 33 }] },
  blacksmith: { label: 'Blacksmith', x: 22, y: 34, seats: [{ x: 22, y: 37 }, { x: 19, y: 37 }] },
  market: { label: 'Market', x: 72, y: 39, seats: [{ x: 72, y: 42 }] },
  merchant: { label: 'Merchant', x: 87, y: 47, seats: [{ x: 87, y: 50 }, { x: 84, y: 50 }] },
  carpenter: { label: 'Carpenter', x: 11, y: 50, seats: [{ x: 11, y: 53 }] },
  workshop: { label: 'Workshop', x: 28, y: 52, seats: [{ x: 28, y: 55 }, { x: 25, y: 55 }, { x: 31, y: 55 }] },
  plaza: { label: 'Grand Plaza', x: 49, y: 57, seats: [{ x: 49, y: 60 }, { x: 46, y: 60 }, { x: 52, y: 60 }] },
  farm: { label: 'Farm', x: 24, y: 64, seats: [{ x: 24, y: 67 }, { x: 21, y: 67 }] },
  stable: { label: 'Stable', x: 70, y: 65, seats: [{ x: 70, y: 68 }] },
  windmill: { label: 'Windmill', x: 51, y: 77, seats: [{ x: 51, y: 80 }] },
  harbor: { label: 'Harbor', x: 21, y: 86, seats: [{ x: 21, y: 89 }] },
  lighthouse: { label: 'Lighthouse', x: 52, y: 92, seats: [{ x: 52, y: 95 }] },
  shipyard: { label: 'Shipyard', x: 76, y: 86, seats: [{ x: 76, y: 89 }, { x: 73, y: 89 }] },
};

// Each entry: title/emoji/building for placement, idle flavor lines, and spriteDir — the
// folder name under characters/ shipping 8 directional PNGs (north/north-east/east/...).
// All 19 roles currently have art; spriteDir would be null (falling back to the emoji
// badge) for any role shipped without one.
const VILLAGE_PROFESSIONS = {
  mayor: {
    title: 'Mayor', emoji: '👑', building: 'townhall', spriteDir: 'Mayor',
    idle: ['reviews the council ledger', 'signs off on a proposal', 'greets a passing villager', 'straightens the town banners'],
  },
  architect: {
    title: 'Architect', emoji: '🏛️', building: 'castle', spriteDir: 'Architect',
    idle: ['unrolls a blueprint', 'measures the castle walls', 'sketches a new wing', 'debates a floor plan with itself'],
  },
  blacksmith: {
    title: 'Blacksmith', emoji: '⚒️', building: 'blacksmith', spriteDir: 'Blacksmith',
    idle: ['stokes the forge', 'hammers a spare part', 'sharpens a tool', 'wipes soot from the anvil'],
  },
  carpenter: {
    title: 'Carpenter', emoji: '🪚', building: 'carpenter', spriteDir: 'Carpenter',
    idle: ['sands a plank smooth', 'measures twice, cuts once', 'sketches a layout', 'sweeps up wood shavings'],
  },
  librarian: {
    title: 'Librarian', emoji: '📚', building: 'library', spriteDir: 'Librarian',
    idle: ['reshelves a stack of scrolls', 'cross-references two notes', 'dusts an old tome', 'links a page to another'],
  },
  mage: {
    title: 'Mage', emoji: '🔮', building: 'magetower', spriteDir: 'Mage',
    idle: ['studies a glowing diagram', 'mutters an incantation', 'consults a floating rune', 'tests a spell on thin air'],
  },
  painter: {
    title: 'Painter', emoji: '🎨', building: 'windmill', spriteDir: 'Painter',
    idle: ['mixes a fresh palette', 'steps back to study the canvas', 'sketches an idea in the margins', 'cleans a brush'],
  },
  alchemist: {
    title: 'Alchemist', emoji: '🧪', building: 'workshop', spriteDir: 'Alchemist',
    idle: ['measures out a tincture', 'labels a vial', 'watches a mixture bubble', 'double-checks a formula'],
  },
  farmer: {
    title: 'Farmer', emoji: '🌾', building: 'farm', spriteDir: 'Farmer',
    idle: ['checks the crop rows', 'waters the seedlings', 'mends a fence post', 'watches the sky for rain'],
  },
  merchant: {
    title: 'Merchant', emoji: '🛒', building: 'merchant', spriteDir: 'Merchant',
    idle: ['arranges the stall', 'counts the day\'s coin', 'haggles with a customer', 'inspects a new shipment'],
  },
  warehousekeeper: {
    title: 'Warehouse Keeper', emoji: '📦', building: 'harbor', spriteDir: 'Warehouse_Keeper',
    idle: ['stacks a crate just so', 'checks an inventory list', 'labels a storage bin', 'sweeps the warehouse floor'],
  },
  messenger: {
    title: 'Messenger', emoji: '🕊️', building: 'lighthouse', spriteDir: 'Messenger',
    idle: ['double-checks a delivery route', 'catches their breath at the door', 'reties a scroll case', 'watches for the next signal'],
  },
  guardcaptain: {
    title: 'Guard Captain', emoji: '🛡️', building: 'observatory', spriteDir: 'Guard_Captain',
    idle: ['scans the horizon', 'checks the watch schedule', 'polishes a badge', 'walks the perimeter'],
  },
  builder: {
    title: 'Builder', emoji: '🏗️', building: 'shipyard', spriteDir: 'Builder',
    idle: ['lays out fresh timber', 'checks a set of plans', 'hammers in a support beam', 'tests a scaffold\'s weight'],
  },
  scout: {
    title: 'Scout', emoji: '🧭', building: 'stable', spriteDir: 'Scout',
    idle: ['checks a map', 'brushes down a saddle', 'jots down field notes', 'points toward the horizon'],
  },
  judge: {
    title: 'Judge', emoji: '⚖️', building: 'plaza', spriteDir: 'Judge',
    idle: ['reviews a ledger of cases', 'weighs two arguments', 'stamps a verdict', 'consults the town code'],
  },
  innkeeper: {
    title: 'Innkeeper', emoji: '🍺', building: 'market', spriteDir: 'Innkeeper',
    idle: ['wipes down the counter', 'welcomes a new face', 'pours a round', 'swaps stories with a regular'],
  },
  healer: {
    title: 'Healer', emoji: '🩺', building: 'workshop', spriteDir: 'Healer',
    idle: ['checks on a patient', 'mixes a soothing remedy', 'restocks the bandages', 'listens patiently'],
  },
  miner: {
    title: 'Miner', emoji: '⛏️', building: 'library', spriteDir: 'Miner',
    idle: ['sifts through old records', 'taps at a promising vein', 'sorts a pile of findings', 'marks a new tunnel on the map'],
  },
};

// Fallback pool for team members whose role text doesn't match a keyword below —
// deterministic per name/role so the same member always lands on the same profession.
const VILLAGE_PROFESSION_POOL = [
  'blacksmith', 'architect', 'merchant', 'carpenter', 'scout', 'painter',
  'alchemist', 'builder', 'guardcaptain', 'warehousekeeper', 'judge', 'healer', 'miner',
];

function villageSlug(name) {
  return String(name || 'villager').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'villager';
}

// Matches a team member's name/role text against keywords to pick a stable, in-character
// profession. Anything unrecognized still gets a deterministic villager from the fallback
// pool rather than defaulting to one spot.
function resolveVillageProfession(name, roleText) {
  const s = `${name || ''} ${roleText || ''}`.toLowerCase();
  if (/\b(oversee|coordinat|orchestrat|assign task|manage the team|delegat)\b/.test(s)) return 'mayor';
  if (/\b(code|coder|dev|backend|engineer|program|implement|script)\b/.test(s)) return 'blacksmith';
  if (/\b(dashboard|layout|template|frontend|ui|ux|usab)\b/.test(s)) return 'carpenter';
  if (/\b(architect|blueprint|floor ?plan|vault structure|system design)\b/.test(s)) return 'architect';
  if (/\b(organiz|catalog|link notes|wiki|document|manage the vault)\b/.test(s)) return 'librarian';
  if (/\b(prompt|reason|llm|agent orchestrat|mage)\b/.test(s)) return 'mage';
  if (/\b(image|icon|illustrat|draw|visual asset|render.*art)\b/.test(s)) return 'painter';
  if (/\b(test|qa|valid|reliab|error detect|experiment)\b/.test(s)) return 'alchemist';
  if (/\b(schedul|cron|recurring|background job|routine task)\b/.test(s)) return 'farmer';
  if (/\b(integrat|plugin manage|external service|connect.*api|sync.*tool)\b/.test(s)) return 'merchant';
  if (/\b(storage|archive|memory resource|manage files)\b/.test(s)) return 'warehousekeeper';
  if (/\b(rout|deliver.*task|notif|dispatch|hand.?off)\b/.test(s)) return 'messenger';
  if (/\b(security|permission|guard|protect|auth|access control)\b/.test(s)) return 'guardcaptain';
  if (/\b(deploy|new project|scaffold|expand.*workspace|build.*system)\b/.test(s)) return 'builder';
  if (/\b(research|discover|explore|find.*resource|scout)\b/.test(s)) return 'scout';
  if (/\b(review|approve|verify|audit|critique|quality standard)\b/.test(s)) return 'judge';
  if (/\b(chat|conversation|activity log|welcome)\b/.test(s)) return 'innkeeper';
  if (/\b(diagnos|repair|debug|fix.*workflow|system health)\b/.test(s)) return 'healer';
  if (/\b(index|extract|mine|dig|collect.*knowledge)\b/.test(s)) return 'miner';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return VILLAGE_PROFESSION_POOL[h % VILLAGE_PROFESSION_POOL.length];
}

// Generic ambient lines for two idle villagers who bump into each other while wandering —
// deliberately not profession-specific (the per-profession `idle` lines above already cover
// "what am I doing right now"; this is just small talk between two of them).
const SKILL_TITLES = ['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master', 'Grandmaster'];
function skillLevel(experience) {
  const level = Math.min(Math.floor((experience || 0) / 3), SKILL_TITLES.length - 1);
  return { level, title: SKILL_TITLES[level], nextAt: (level + 1) * 3 };
}

const VILLAGE_SMALLTALK = [
  'Busy day, huh?',
  'Have you seen the notice board today?',
  "The weather's been kind to us lately.",
  "How's the work coming along?",
  'Another Town Hall meeting soon, I heard.',
  'Anything interesting happen today?',
  'Mind if I borrow that later?',
  'Good to see a friendly face.',
  'Did you hear back from the Mayor yet?',
  'This village keeps getting busier.',
];

module.exports = {
  VILLAGE_BUILDINGS,
  VILLAGE_PROFESSIONS,
  VILLAGE_PROFESSION_POOL,
  VILLAGE_SMALLTALK,
  villageSlug,
  resolveVillageProfession,
  skillLevel,
};
