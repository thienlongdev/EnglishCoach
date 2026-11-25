export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const WEATHER_STATES = {
  sunny: {
    id: 'sunny',
    label: 'Sunny',
    skyTint: [0.49, 0.24, 0.64],
    sunMult: 1.08,
    skyMult: 1.05,
    rain: false,
    npcMoodNote: 'Clear skies bring students out onto Riverside Park and University Green.',
  },
  cloudy: {
    id: 'cloudy',
    label: 'Partly Cloudy',
    skyTint: [0.53, 0.14, 0.56],
    sunMult: 0.78,
    skyMult: 0.96,
    rain: false,
    npcMoodNote: 'Cool shaded air — ideal for long walks along the Greenway.',
  },
  golden_breeze: {
    id: 'golden_breeze',
    label: 'Warm Breeze',
    skyTint: [0.11, 0.34, 0.60],
    sunMult: 1.15,
    skyMult: 1.0,
    rain: false,
    npcMoodNote: 'Golden light makes Riverside Atelier and Fountain Court glow.',
  },
  light_rain: {
    id: 'light_rain',
    label: 'Light Rain',
    skyTint: [0.56, 0.16, 0.42],
    sunMult: 0.48,
    skyMult: 0.82,
    rain: true,
    npcMoodNote: 'Gentle rain nudges outdoor regulars indoors to Willow Bistro, Pixel Café, and the Library.',
  },
};

export const WORLD_EVENTS = [
  {
    id: 'evt_morning_run_club',
    title: 'Riverside Morning Run Club',
    zone: 'park',
    days: [0, 2, 4], // Mon, Wed, Fri
    startHour: 7,
    endHour: 10,
    allowInRain: false,
    participants: ['minh', 'tuankiet', 'linh', 'minhthu'],
    summary: 'Minh and Tuan Kiet lead a friendly warm-up circuit around Riverside Park.',
    activityAction: 'event_participate',
    rewardCredits: 35,
    rewardSkill: 'mobility',
    props: [['v3_paper_lantern', -1.5, 4.5, 2.2]],
  },
  {
    id: 'evt_market_produce_sale',
    title: 'Sunrise Market Flash Produce Sale',
    zone: 'market',
    days: [1, 3], // Tue, Thu
    startHour: 10,
    endHour: 15,
    allowInRain: true,
    participants: ['mai', 'khanhha', 'ngocbich'],
    summary: 'Mai marks down fresh groceries & cooking kits by 20% and hosts tasting tips.',
    activityAction: 'event_participate',
    rewardCredits: 30,
    rewardSkill: 'business',
    groceryDiscount: 0.2,
    props: [['v3_garden_planter', 0.2, -3.5, 0]],
  },
  {
    id: 'evt_pixel_rhythm_jam',
    title: 'Pixel Café Indie Rhythm Jam',
    zone: 'cafe',
    days: [2, 4, 6], // Wed, Fri, Sun
    startHour: 17,
    endHour: 23,
    allowInRain: true,
    participants: ['huy', 'duykhoa', 'baolong', 'haidang'],
    summary: 'Huy and Duy Khoa run friendly live rhythm brackets with bonus Tech XP.',
    activityAction: 'event_participate',
    rewardCredits: 45,
    rewardSkill: 'technology',
    props: [['v3_paper_lantern', 0, -2.2, 2.1]],
  },
  {
    id: 'evt_open_mic_fountain',
    title: 'Acoustic Open-Mic Night',
    zone: 'fountain_plaza',
    days: [3, 5], // Thu, Sat
    startHour: 17,
    endHour: 22,
    allowInRain: false,
    participants: ['haidang', 'diemmy', 'linh', 'thaovy', 'minhthu'],
    summary: 'Hai Dang hosts twilight acoustic sets around Old Campus Fountain Court.',
    activityAction: 'event_participate',
    rewardCredits: 50,
    rewardSkill: 'social',
    props: [['v3_acoustic_guitar', -1.6, -5.4, 0.45], ['v3_paper_lantern', -3.0, -5.0, 2.2], ['v3_paper_lantern', 3.0, -5.0, 2.2]],
  },
  {
    id: 'evt_weekend_artisan_market',
    title: 'Weekend Artisan & Book Market',
    zone: 'fountain_plaza',
    days: [5, 6], // Sat, Sun
    startHour: 9,
    endHour: 16,
    allowInRain: false,
    participants: ['yennhi', 'kimngan', 'phuonglien', 'diemmy', 'anchi'],
    summary: 'Local students set up handmade art prints, used books, and design crafts.',
    activityAction: 'event_participate',
    rewardCredits: 55,
    rewardSkill: 'diy_design',
    props: [['v3_art_easel', 4.6, -1.0, 0], ['v3_paper_lantern', 6.4, -3.2, 2.3]],
  },
  {
    id: 'evt_park_3v3_pickup',
    title: 'Riverside Park 3v3 Pickup Showcase',
    zone: 'park',
    days: [5], // Sat
    startHour: 13,
    endHour: 18,
    allowInRain: false,
    participants: ['minh', 'duykhoa', 'quocbao', 'tuankiet'],
    summary: 'Crowd-cheered pickup basketball games with friendly rivalry and fitness boosts.',
    activityAction: 'event_participate',
    rewardCredits: 50,
    rewardSkill: 'mobility',
    props: [['v3_trophy_cup', -2.5, -4.2, 0.85]],
  },
  {
    id: 'evt_lantern_twilight',
    title: 'Lantern Twilight Tea Gathering',
    zone: 'lantern_garden',
    days: [6, 2], // Sun, Wed
    startHour: 18,
    endHour: 23,
    allowInRain: true,
    participants: ['ngocbich', 'anchi', 'thaovy', 'lan'],
    summary: 'A calm evening tea ritual under paper lanterns in the Hidden Lantern Tea Garden.',
    activityAction: 'event_participate',
    rewardCredits: 60,
    rewardSkill: 'social',
    props: [['v3_paper_lantern', -2.2, -1.6, 2.0], ['v3_paper_lantern', 2.2, -1.6, 2.0]],
  },
  {
    id: 'evt_silicon_showcase',
    title: 'Volt & Silicon Hardware Showcase',
    zone: 'electronics_shop',
    days: [4, 1], // Fri, Tue
    startHour: 12,
    endHour: 19,
    allowInRain: true,
    participants: ['baolong', 'huy', 'ductri', 'hoangphuc'],
    summary: 'Bao Long demos overclocked builds and shares rare electronics materials.',
    activityAction: 'event_participate',
    rewardCredits: 45,
    rewardSkill: 'technology',
    props: [['v3_trophy_cup', 0, -3.2, 0.86]],
  },
  {
    id: 'evt_connection_festival',
    title: 'Student Connection Festival',
    zone: 'campus',
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: 8,
    endHour: 22,
    allowInRain: true,
    requiresFlagOrDone: 'supplies',
    participants: ['linh', 'minh', 'huy', 'mai', 'lan', 'thaovy', 'haidang', 'diemmy', 'yennhi'],
    summary: 'University Green comes alive with booths, music, handwritten welcomes, and student showcases!',
    activityAction: 'event_participate',
    rewardCredits: 65,
    rewardSkill: 'social',
    props: [['v3_paper_lantern', -4, 3, 2.2], ['v3_paper_lantern', 4, 3, 2.2], ['v3_art_easel', 0, 2.2, 0]],
  },
];

export function getCalendar(clock) {
  const totalMinutes = Math.max(0, Math.floor(clock || 0));
  const dayIndex = Math.floor(totalMinutes / 1440);
  const minuteOfDay = totalMinutes % 1440;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const weekdayIdx = dayIndex % 7;
  const weekday = WEEKDAYS[weekdayIdx];
  const isWeekend = weekdayIdx >= 5;
  const phase = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'night';
  const timeText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { dayIndex, weekdayIdx, weekday, isWeekend, hour, minute, phase, timeText };
}

export function getWeather(s) {
  if (s.worldV3?.weatherOverride && WEATHER_STATES[s.worldV3.weatherOverride]) {
    return WEATHER_STATES[s.worldV3.weatherOverride];
  }
  const cal = getCalendar(s.clock);
  // Deterministic 6-hour weather slot; Day 0 morning starts Sunny so onboarding feels welcoming
  if (cal.dayIndex === 0 && cal.hour < 14) return WEATHER_STATES.sunny;
  const slot = cal.dayIndex * 4 + Math.floor(cal.hour / 6);
  const pattern = ['sunny', 'golden_breeze', 'cloudy', 'sunny', 'light_rain', 'sunny', 'golden_breeze', 'cloudy', 'sunny', 'light_rain'];
  const id = pattern[Math.abs((slot * 3 + (s.seed % 5)) % pattern.length)];
  return WEATHER_STATES[id] || WEATHER_STATES.sunny;
}

export function getActiveEvents(s) {
  const cal = getCalendar(s.clock);
  const weather = getWeather(s);
  return WORLD_EVENTS.filter(ev => {
    if (ev.requiresFlagOrDone) {
      const unlocked = s.done?.includes(ev.requiresFlagOrDone) || s.sandbox;
      if (!unlocked) return false;
      // Post-story festival runs on weekends & Fridays so campus also has quiet normal weekdays
      if (s.sandbox && ![4, 5, 6].includes(cal.weekdayIdx)) return false;
    }
    if (!ev.days.includes(cal.weekdayIdx)) return false;
    if (cal.hour < ev.startHour || cal.hour >= ev.endHour) return false;
    if (weather.rain && !ev.allowInRain) return false;
    return true;
  });
}

export function isZoneOpen(zoneObj, clock) {
  if (!zoneObj?.openHours) return { open: true, note: 'Open 24h' };
  const { hour } = getCalendar(clock);
  const [openH, closeH] = zoneObj.openHours;
  const open = hour >= openH && hour < closeH;
  return {
    open,
    note: open ? `Open (${String(openH).padStart(2, '0')}:00–${String(closeH).padStart(2, '0')}:00)` : `After-hours bell (${String(openH).padStart(2, '0')}:00–${String(closeH).padStart(2, '0')}:00)`,
  };
}
