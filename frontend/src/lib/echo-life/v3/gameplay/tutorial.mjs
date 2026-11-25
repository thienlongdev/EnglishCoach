/**
 * Echo Life V3 — Mandatory 10-Step Interactive First-Time Player Tutorial
 * "Welcome to Echo Life": teaches every core mechanic progressively via real gameplay,
 * saves after every step, supports Skip & Settings Replay, bypasses returning players,
 * adapts phrasing for desktop vs. mobile touch, and stays strictly English regardless of locale.
 */
export const TUTORIAL_STEPS = [
  {
    id: 'tut_movement',
    index: 0,
    title: 'Step 1 · Movement & Camera',
    desktopHint: 'Move with WASD (or arrows), drag the scene to turn camera, hold Shift to sprint, and press Space to jump.',
    mobileHint: 'Use the bottom-left directional pad to walk, drag the screen to look around, and tap Sprint or Jump.',
    goalLabel: 'Walk around your Study Room and try jumping once.',
    check: (t) => t.movedDist >= 1.2 && t.jumped,
  },
  {
    id: 'tut_interaction',
    index: 1,
    title: 'Step 2 · Interacting With the World',
    desktopHint: 'Walk near your Study Desk or Floor Lamp and press E (or click the bottom prompt button) to interact.',
    mobileHint: 'Walk near your Study Desk or Floor Lamp and tap the contextual button at the bottom of the screen.',
    goalLabel: 'Interact with any object in your room (Desk, Lamp, or Door).',
    check: (t) => t.interactedObject,
  },
  {
    id: 'tut_npc',
    index: 2,
    title: 'Step 3 · Meeting Living NPCs',
    desktopHint: 'Head through the Hallway into the Living Room — your neighbor Linh stopped by to say hello! Talk to her and choose a reply.',
    mobileHint: 'Enter the Living Room (or tap Map → Living room), approach Linh, and tap her name to talk.',
    goalLabel: 'Start a conversation with Linh (or any neighbor) and see relationship feedback.',
    check: (t) => t.talkedNpc,
  },
  {
    id: 'tut_map',
    index: 3,
    title: 'Step 4 · Map & Navigation',
    desktopHint: 'Press M (or click Map) to view districts, NPC locations, active events, and undiscovered mystery markers — then travel to another zone.',
    mobileHint: 'Tap Map in the toolbar to browse districts, see where friends are, and tap a destination to walk there.',
    goalLabel: 'Open the Map and navigate to another neighborhood zone.',
    check: (t) => t.openedMap && t.changedZone,
  },
  {
    id: 'tut_inventory',
    index: 4,
    title: 'Step 5 · Inventory & Ownership',
    desktopHint: 'Pick up an item (like the Living Room broom or a collectible) and open your Bag to inspect Campus Credits, ingredients, materials, and owned objects.',
    mobileHint: 'Pick up an item or collectible, then tap Bag to inspect your ingredients, materials, and persistent owned items.',
    goalLabel: 'Open your Bag to inspect your inventory and owned items.',
    check: (t) => t.openedBag,
  },
  {
    id: 'tut_economy',
    index: 5,
    title: 'Step 6 · Economy & Shops',
    desktopHint: 'Visit Sunrise Market (or click Shops) to inspect items, check your Campus Credits (CC), and purchase an affordable item.',
    mobileHint: 'Open Shops or visit Sunrise Market, check your Campus Credits (CC), and buy any affordable item.',
    goalLabel: 'Browse a store and purchase any affordable item.',
    check: (t) => t.purchasedItem,
  },
  {
    id: 'tut_build',
    index: 6,
    title: 'Step 7 · Home & Build Mode',
    desktopHint: 'Return to any home room (Study, Living, Kitchen, Bedroom), press B (or click Build), select a piece of furniture, rotate or restyle it, and save!',
    mobileHint: 'Inside your home, tap Build, choose an owned item, preview placement or rotate/restyle it.',
    goalLabel: 'Open Build Mode and rotate, move, place, or customize a home item.',
    check: (t) => t.usedBuildMode,
  },
  {
    id: 'tut_journal',
    index: 7,
    title: 'Step 8 · Quests, Story & Journal',
    desktopHint: 'Press J (or click Journal) to track your 5-chapter Main Story, branching choices, and 14 Side Quest Arcs — or open People to view all 22 residents.',
    mobileHint: 'Tap Journal to inspect Main Story missions and 14 Side Arcs, or People to view NPC schedules.',
    goalLabel: 'Open the Journal to review your story objectives and side arcs.',
    check: (t) => t.openedJournal,
  },
  {
    id: 'tut_transport',
    index: 8,
    title: 'Step 9 · Bicycles & Open-Road Vehicles',
    desktopHint: 'Go to your Home Garden (yard), approach your Bicycle, press E to mount, ride with W/A/S/D, brake with Space, and press X to dismount.',
    mobileHint: 'Go to Home Garden, tap your Bicycle to mount, steer with the pad, and tap Dismount when ready.',
    goalLabel: 'Mount and ride your bicycle in Home Garden or Riverside Lane.',
    check: (t) => t.rodeVehicle,
  },
  {
    id: 'tut_explore',
    index: 9,
    title: 'Step 10 · Free Exploration Awaits',
    desktopHint: 'Open Explore (or walk into a new district / collect a keepsake / attend an event). Riverside is yours — follow the story or live freely at your own pace!',
    mobileHint: 'Tap Explore or discover a new landmark or keepsake. You can roam, socialize, work, and build anytime!',
    goalLabel: 'Open Explore or discover a landmark/keepsake to finish the introduction.',
    check: (t) => t.exploredFree,
  },
];

export function createTutorialState(returningPlayer = false) {
  return {
    active: !returningPlayer,
    completed: false,
    skipped: returningPlayer,
    stepIndex: 0,
    completedSteps: [],
    flags: {
      movedDist: 0,
      jumped: false,
      interactedObject: false,
      talkedNpc: false,
      openedMap: false,
      changedZone: false,
      openedBag: false,
      purchasedItem: false,
      usedBuildMode: false,
      openedJournal: false,
      rodeVehicle: false,
      exploredFree: false,
    },
  };
}

export function getCurrentTutorialStep(s) {
  const tut = s.worldV3?.tutorial;
  if (!tut || !tut.active || tut.completed || tut.skipped) return null;
  return TUTORIAL_STEPS[tut.stepIndex] || null;
}

export function recordTutorialSignal(s, signal, amount = 1) {
  const tut = s.worldV3?.tutorial;
  if (!tut || !tut.active || tut.completed || tut.skipped) return null;
  const f = tut.flags;
  if (signal === 'move') f.movedDist = Math.min(100, (f.movedDist || 0) + amount);
  else if (Object.hasOwn(f, signal)) f[signal] = true;

  let advancedTo = null;
  // Advance step if current step's real gameplay condition is met
  while (tut.stepIndex < TUTORIAL_STEPS.length) {
    const step = TUTORIAL_STEPS[tut.stepIndex];
    if (!step.check(f)) break;
    if (!tut.completedSteps.includes(step.id)) tut.completedSteps.push(step.id);
    tut.stepIndex += 1;
    advancedTo = tut.stepIndex;
  }
  if (tut.stepIndex >= TUTORIAL_STEPS.length) {
    tut.completed = true;
    tut.active = false;
    return { completedAll: true, msg: 'Tutorial complete! Welcome to Echo Life — explore freely, make friends, or follow A Semester to Remember.' };
  }
  if (advancedTo !== null) {
    const next = TUTORIAL_STEPS[tut.stepIndex];
    // When advancing to Step 3 while player is still in Study Room, have Linh waiting warmly in Living Room (out of sight, zero visible pop-in)
    if (next?.id === 'tut_npc' && s.npcs?.linh && s.player?.zone !== 'living') {
      Object.assign(s.npcs.linh, { zone: 'living', x: 0.4, z: 0.6, path: [], target: null, activity: 'wave', scheduleNote: 'Stopped by to welcome you to Riverside Lane' });
    }
    return { advanced: true, step: next, msg: `Tutorial progress saved · Next: ${next.title}` };
  }
  return null;
}

export function skipTutorial(s) {
  const tut = s.worldV3?.tutorial;
  if (!tut) return;
  tut.skipped = true;
  tut.active = false;
}

export function replayTutorial(s) {
  if (!s.worldV3) return;
  s.worldV3.tutorial = createTutorialState(false);
}

export const CONTROLS_REFERENCE = [
  { group: 'Movement', desktop: 'WASD / Arrows (ZQSD in Settings) · Shift = Sprint · C = Crouch · Space = Jump', mobile: 'Bottom-left D-pad · Sprint & Jump touch buttons' },
  { group: 'Camera', desktop: 'Click & drag anywhere on world canvas · First/Third person toggle in Settings', mobile: 'Touch & drag on the 3D scene to orbit camera' },
  { group: 'Interact & NPCs', desktop: 'E (or click bottom prompt) to talk, open doors, collect relics, use objects', mobile: 'Tap contextual action pill at bottom center' },
  { group: 'Tools & Vehicles', desktop: 'E to mount bike or enter car · W/S drive, A/D steer, Space brake · X to dismount/exit/stand/drop', mobile: 'Tap Mount/Drive & Dismount/Exit button' },
  { group: 'Quick Panels', desktop: 'M = Map · J = Journal · P = People · O = Explore · B = Build Mode · H = Controls · Esc = Close/Pause', mobile: 'Scrollable toolbar pills along bottom edge' },
];
