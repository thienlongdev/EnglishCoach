import type { GardenPlot, GardenState } from "@/types/garden";

/**
 * Echo guide — what Echo says and what it points at (pure data + pure functions of the server state; no React, no
 * rendering). A step never commands the game: it names a REAL control or world object (`dom:<id>` = an element that
 * carries `data-guide="<id>"`, `world:<id>` = a selection id of the scene) and what the player's own action must be
 * for the step to count. When that action is impossible right now (no free bed, no seed, no water) the step turns
 * into a truthful explanation with "Tiếp tục" instead of waiting for something that cannot happen.
 */
export interface GuideCtx {
  state: GardenState;
  /** the bed whose sheet is open (slot), or null */
  openSlot: number | null;
}

/** next = Echo explains and the player continues; the others wait for the player's own confirmed action. */
export type GuideExpect = "next" | "plot" | "planted" | "watered" | "time";

export interface GuideStep {
  id: string;
  text: (c: GuideCtx) => string;
  target: (c: GuideCtx) => string | null;
  expect: (c: GuideCtx) => GuideExpect;
  /** presentation set up when the step starts: panels put away, the camera home or on a place */
  arrange?: { closePanels?: boolean; home?: boolean; focus?: (c: GuideCtx) => string | null };
  /** false = the scene is not dimmed (the player must judge the sky, or play freely) */
  dim?: boolean;
  /** true = nothing is blocked: the player pans, zooms and taps freely while Echo points */
  free?: boolean;
}

export interface GuideTopic {
  id: string;
  title: string;
  hint: string;
  steps: GuideStep[];
}

export const STARTER_ID = "start";
export const STARTER_STEPS = 7;

// ------------------------------------------------------------------ facts read from the server state

const bySlot = (a: GardenPlot, b: GardenPlot) => a.slot - b.slot;

export function emptyPlot(state: GardenState): GardenPlot | null {
  return [...state.plots].sort(bySlot).find((p) => !p.planting) ?? null;
}

export function plotBySlot(state: GardenState, slot: number | null): GardenPlot | null {
  return slot === null ? null : state.plots.find((p) => p.slot === slot) ?? null;
}

/** A seed the player holds, or one the stall sells that the player can pay for now. */
export function canPlantSomething(state: GardenState): boolean {
  const held = new Map(state.inventory.seeds.map((s) => [s.cropCode, s.qty]));
  return state.crops.some((c) => c.unlocked && ((held.get(c.code) ?? 0) > 0
    || (c.purchasable && state.profile.coins >= c.seedPrice && state.profile.essence >= c.seedEssence)));
}

/** The same rule as the bed sheet's "Tưới" button (PlotPanel): a growing crop that still takes water, and water in stock. */
export function canWater(state: GardenState, plot: GardenPlot | null): boolean {
  const p = plot?.planting;
  const water = state.boosts.find((b) => b.code === "WATER");
  return !!p && !p.ready && p.id > 0 && !!water && p.waterCount < p.waterLimit && state.inventory.water > 0
    && p.boostFraction + water.fraction <= p.maxBoost + 1e-9;
}

export function waterablePlot(state: GardenState, preferSlot: number | null): GardenPlot | null {
  const preferred = plotBySlot(state, preferSlot);
  if (canWater(state, preferred)) return preferred;
  return [...state.plots].sort(bySlot).find((p) => canWater(state, p)) ?? null;
}

export function growingPlot(state: GardenState, preferSlot: number | null): GardenPlot | null {
  const preferred = plotBySlot(state, preferSlot);
  if (preferred?.planting && !preferred.planting.ready) return preferred;
  return [...state.plots].sort(bySlot).find((p) => p.planting && !p.planting.ready) ?? null;
}

export function ripePlot(state: GardenState): GardenPlot | null {
  return [...state.plots].sort(bySlot).find((p) => p.planting?.ready) ?? null;
}

const world = (id: string) => `world:${id}`;
const dom = (id: string) => `dom:${id}`;
const plotTarget = (p: GardenPlot | null) => (p ? world(`plot_${p.slot}`) : world("farm_zone"));
const explain = (): GuideExpect => "next";

// ------------------------------------------------------------------ the three hands-on steps (shared by two guides)

const FIND_PLOT: GuideStep = {
  id: "find-plot",
  // the camera goes to the bed itself: on a phone the whole farm does not fit the screen
  arrange: { closePanels: true, focus: (c) => (emptyPlot(c.state) ? `plot_${emptyPlot(c.state)!.slot}` : "farm_zone") },
  text: (c) => (emptyPlot(c.state)
    ? "Đây là ô đất để trồng cây. Hãy nhấn vào một ô đất trống nhé!"
    : "Mọi ô đất của bạn đều đang có cây rồi. Khi thu hoạch xong, bạn chạm vào ô đất trống để gieo hạt mới nhé!"),
  target: (c) => plotTarget(emptyPlot(c.state)),
  expect: (c) => (emptyPlot(c.state) ? "plot" : "next"),
};

const PLANT: GuideStep = {
  id: "plant",
  text: (c) => {
    if (!emptyPlot(c.state)) return "Các ô đất đều đã có cây. Lần tới, bạn chạm vào ô đất trống rồi chọn hạt giống để gieo. Cây sẽ lớn lên theo thời gian thật!";
    if (!canPlantSomething(c.state)) {
      return "Bạn chưa có hạt giống và chưa đủ Đồng Echo để mua hạt. Bán nông sản trong Kho hoặc giao đơn hàng sẽ mang về Đồng Echo, rồi bạn mua hạt ngay khi gieo.";
    }
    return "Chọn một hạt giống bạn đang có rồi gieo xuống đất. Cây sẽ lớn lên theo thời gian thật!";
  },
  target: (c) => {
    const open = plotBySlot(c.state, c.openSlot);
    if (open && !open.planting) return dom("seed-list");
    return plotTarget(emptyPlot(c.state));
  },
  expect: (c) => (emptyPlot(c.state) && canPlantSomething(c.state) ? "planted" : "next"),
};

const WATER: GuideStep = {
  id: "water",
  text: (c) => {
    if (waterablePlot(c.state, c.openSlot)) return "Cây cần được chăm sóc. Nhấn nút tưới nước để giữ cho đất đủ ẩm nhé!";
    if (!growingPlot(c.state, c.openSlot)) return "Khi có cây đang lớn, bạn chạm vào ô đất rồi nhấn Tưới để chăm cây. Nước đến từ việc ôn thẻ từ vựng.";
    if (c.state.inventory.water <= 0) return "Bạn đã dùng hết nước rồi. Nước đến từ việc ôn thẻ từ vựng: ôn thêm thẻ là Echo mang nước về cho đảo.";
    return "Cây này đã được tưới đủ rồi, không cần tưới thêm nữa. Mỗi cây chỉ nhận một số lần tưới thôi!";
  },
  target: (c) => {
    const w = waterablePlot(c.state, c.openSlot);
    if (w) return c.openSlot === w.slot ? dom("water") : plotTarget(w);
    return plotTarget(growingPlot(c.state, c.openSlot));
  },
  expect: (c) => (waterablePlot(c.state, c.openSlot) ? "watered" : "next"),
};

// ------------------------------------------------------------------ the starter guide (seven milestones)

export const STARTER: GuideStep[] = [
  {
    id: "island",
    arrange: { closePanels: true, home: true },
    text: () => "Đây là Đảo Ký Ức của bạn! Học tiếng Anh mỗi ngày sẽ giúp bạn xây dựng một nông trại thật đặc biệt.",
    target: () => world("island"),
    expect: explain,
  },
  FIND_PLOT,
  PLANT,
  WATER,
  {
    id: "pests",
    arrange: { closePanels: true, home: true },
    text: (c) => "Đảo Ký Ức gắn liền với việc học tiếng Anh. Khi sâu xuất hiện, hãy ôn đúng từ vựng để bảo vệ cây nhé!"
      + (c.state.pests.length > 0 ? " Trên đảo đang có Sâu Lãng Quên: chạm vào nó để ôn đúng từ nó mang, sâu sẽ rời đi ngay." : ""),
    target: () => dom("learning"),
    expect: explain,
  },
  {
    id: "warehouse",
    text: () => "Khi cây chín, bạn có thể thu hoạch nông sản, cất trong Kho, bán hoặc hoàn thành đơn hàng để nhận Đồng Echo!",
    target: () => dom("kho"),
    expect: explain,
  },
  {
    id: "discover",
    text: () => "Trên đảo còn có Cây Tri Thức, chuồng trại, thú cưng, đảo bạn bè và Tiệm Trang Trí. Bạn có thể khám phá chúng bất cứ lúc nào!",
    target: () => dom("dock"),
    expect: explain,
  },
];

export const STARTER_FAREWELL = "Tuyệt lắm! Giờ bạn đã sẵn sàng xây dựng Đảo Ký Ức của riêng mình rồi!";

// ------------------------------------------------------------------ help topics (explanations of what already exists)

function animalsLine(state: GardenState): string {
  const a = state.animals;
  if (!a) return "Chuồng trại chưa mở trên đảo của bạn.";
  const built = a.houses.filter((h) => h.built);
  if (built.length > 0) return `Bạn đang có ${built.map((h) => h.nameVi).join(", ")}.`;
  const first = [...a.houses].sort((x, y) => x.minLevel - y.minLevel)[0];
  return first ? `Chuồng đầu tiên là ${first.nameVi}: mở ở Cấp ${first.minLevel}, giá ${first.coins.toLocaleString("vi-VN")} Đồng Echo.` : "";
}

export const TOPICS: GuideTopic[] = [
  { id: STARTER_ID, title: "Bắt đầu chơi", hint: "Một vòng quanh đảo cùng Echo, khoảng 2 phút", steps: STARTER },
  { id: "plant-water", title: "Trồng cây và tưới nước", hint: "Chọn ô đất, gieo hạt, tưới", steps: [FIND_PLOT, PLANT, WATER] },
  {
    id: "harvest",
    title: "Thu hoạch và Kho",
    hint: "Thu nông sản đã chín, cất vào Kho",
    steps: [
      {
        id: "harvest-plot",
        arrange: { closePanels: true, focus: (c) => (ripePlot(c.state) ? `plot_${ripePlot(c.state)!.slot}` : "farm_zone") },
        text: (c) => (ripePlot(c.state)
          ? "Ô đất này đã chín! Chạm vào ô rồi nhấn Thu hoạch. Bạn trả lời 3 câu nhớ nhanh từ thẻ của mình: trả lời đúng thì nông sản đạt chất lượng cao hơn."
          : "Cây lớn theo thời gian thật, kể cả khi bạn rời đảo. Khi cây chín, bạn chạm vào ô đất rồi nhấn Thu hoạch và trả lời 3 câu nhớ nhanh để nông sản đạt chất lượng cao hơn."),
        target: (c) => plotTarget(ripePlot(c.state)),
        expect: explain,
      },
      {
        id: "harvest-kho",
        text: () => "Nông sản thu được nằm trong Kho. Ở đó bạn xem số lượng, chất lượng và bán từng loại để nhận Đồng Echo.",
        target: () => dom("kho"),
        expect: explain,
      },
    ],
  },
  {
    id: "coins",
    title: "Đồng Echo và đơn hàng",
    hint: "Kiếm và dùng Đồng Echo",
    steps: [
      {
        id: "coins-counter",
        arrange: { closePanels: true },
        text: () => "Đây là Đồng Echo của bạn. Bạn kiếm Đồng Echo bằng cách bán nông sản, giao đơn hàng và thu hoạch. Đồng Echo chỉ có được nhờ chơi và học, không bán bằng tiền thật.",
        target: () => dom("coins"),
        expect: explain,
      },
      {
        id: "coins-orders",
        arrange: { focus: () => "prop_signpost" },
        text: () => "Cột chỉ đường giữ bảng giao hàng. Mỗi đơn ghi rõ nông sản cần giao và phần thưởng: giao đủ là nhận đúng phần thưởng ghi trên đơn.",
        target: () => world("prop_signpost"),
        expect: explain,
      },
      {
        id: "coins-stall",
        arrange: { focus: () => "market_stall" },
        text: () => "Quầy Chợ Echo bán hạt giống và vật tư chăm cây bằng Đồng Echo. Hàng trên quầy đổi theo ngày.",
        target: () => world("market_stall"),
        expect: explain,
      },
    ],
  },
  {
    id: "review",
    title: "Ôn từ và xua sâu",
    hint: "Việc học nuôi đảo, ôn từ để xua Sâu Lãng Quên",
    steps: [
      {
        id: "review-goal",
        arrange: { closePanels: true, home: true },
        text: () => "Mỗi lượt ôn thẻ từ vựng mang nước về cho đảo. Chạm vào đây để xem hôm nay việc học đã mang về những gì.",
        target: () => dom("learning"),
        expect: explain,
      },
      {
        id: "review-pest",
        arrange: { focus: () => "farm_zone" },
        text: (c) => (c.state.pests.length > 0
          ? "Sâu Lãng Quên bám vào cây khi một từ của bạn đã quá hạn ôn. Chạm vào sâu và ôn đúng từ nó mang: chọn Khó, Tốt hay Dễ đều tính, và sâu rời đi ngay."
          : "Hiện đảo không có sâu. Sâu Lãng Quên chỉ xuất hiện khi một từ của bạn quá hạn ôn. Khi đó, chạm vào sâu và ôn đúng từ nó mang (Khó, Tốt hay Dễ đều tính) là sâu rời đi ngay."),
        target: () => world("farm_zone"),
        expect: explain,
      },
    ],
  },
  {
    id: "tree",
    title: "Cây Tri Thức",
    hint: "Cây lớn theo những ngày bạn học",
    steps: [
      {
        id: "tree-monument",
        arrange: { closePanels: true, focus: () => "knowledge_tree" },
        text: () => "Cây Tri Thức ghi lại những ngày bạn học thật ở English Coach và lớn dần theo đó. Chạm vào cây để xem các mốc đã đạt và lối vào Vườn tri thức.",
        target: () => world("knowledge_tree"),
        expect: explain,
      },
      {
        id: "tree-grove",
        text: () => "Trong Vườn tri thức, bạn trồng Cây Ký Ức từ 5 thẻ từ vựng của chính mình. Ôn những thẻ đó đều đặn thì cây lớn, rồi tốt nghiệp vào Rừng Ký Ức.",
        target: () => world("knowledge_tree"),
        expect: explain,
      },
    ],
  },
  {
    id: "animals",
    title: "Chuồng trại và vật nuôi",
    hint: "Gà, vịt, lợn, cừu",
    steps: [
      {
        id: "animals-kho",
        arrange: { closePanels: true },
        text: (c) => `Chuồng trại nằm trong Kho, ở thẻ Trại. ${animalsLine(c.state)}`,
        target: () => dom("kho"),
        expect: explain,
      },
      {
        id: "animals-care",
        text: () => "Vật nuôi cần cám và nước. Cám được xay từ nông sản trong Kho. Chăm đủ thì chúng lớn và cho sản phẩm để bán lấy Đồng Echo. Vật nuôi không bao giờ chết hay bỏ đi: thiếu chăm sóc chỉ làm chúng lớn chậm lại.",
        target: () => dom("kho"),
        expect: explain,
      },
    ],
  },
  {
    id: "guardians",
    title: "Thú cưng bảo vệ",
    hint: "Chó, ngỗng và mèo canh đảo",
    steps: [
      {
        id: "guardians-what",
        arrange: { closePanels: true },
        text: () => "Chó canh vườn, Ngỗng gác vườn và Mèo đồng cũng ở thẻ Trại trong Kho, mua bằng Đồng Echo. Chúng chỉ làm việc khi được cho ăn.",
        target: () => dom("kho"),
        expect: explain,
      },
      {
        id: "guardians-how",
        text: () => "Chó xua một lượt khách định lấy nông sản rồi canh đảo thêm một lúc. Ngỗng cho bạn thêm thời gian thu hoạch trước khi khách có thể lấy. Mèo giữ bớt chỗ để sâu hại cây trồng khó bám vào.",
        target: () => dom("kho"),
        expect: explain,
      },
    ],
  },
  {
    id: "social",
    title: "Đảo bạn bè",
    hint: "Ghé thăm đảo của người chơi khác",
    steps: [
      {
        id: "social-open",
        arrange: { closePanels: true },
        text: (c) => (c.state.social
          ? "Ở Đảo bạn bè, bạn khám phá đảo của những người chơi thật đã mở cửa và ghé thăm để ngắm. Đảo của bạn chỉ hiện với người khác khi chính bạn chọn mở cửa."
          : "Đảo bạn bè chưa mở trên đảo của bạn."),
        target: (c) => (c.state.social ? dom("social") : null),
        expect: explain,
      },
      {
        id: "social-take",
        text: (c) => (c.state.social
          ? `Khi ghé thăm, bạn có thể "Lấy một ít" từ một cây đã chín: nhiều nhất 1/${c.state.social.unitPortions} nông sản đó. Chủ đảo được báo ngay và vẫn thu phần còn lại. Không ai lấy được Đồng Echo, hạt giống hay đồ trang trí của bạn.`
          : "Khi tính năng mở, bạn sẽ thấy nút Đảo bạn bè cạnh nút Kho."),
        target: (c) => (c.state.social ? dom("social") : null),
        expect: explain,
      },
    ],
  },
  {
    id: "cosmetics",
    title: "Tiệm Trang Trí và Skin",
    hint: "Diện mạo cho đảo",
    steps: [
      {
        id: "cosmetics-stall",
        arrange: { closePanels: true, focus: () => "market_stall" },
        text: () => "Tiệm Trang Trí mở từ Quầy Chợ Echo. Ở đó có nhà, cây, hàng rào, vật trang trí và giống cây đặc biệt. Bạn thử trước trên đảo rồi mới quyết định.",
        target: () => world("market_stall"),
        expect: explain,
      },
      {
        id: "cosmetics-rule",
        text: () => "Diện mạo chỉ để ngắm: không làm cây lớn nhanh hơn hay bán được giá hơn. Giá từng món hiện ngay trong tiệm; hướng dẫn này không mua gì và không mở đơn thanh toán nào thay bạn.",
        target: () => world("market_stall"),
        expect: explain,
      },
    ],
  },
  {
    id: "rewards",
    title: "Premium và AI Voucher",
    hint: "Đổi Đồng Echo lấy phần thưởng",
    steps: [
      {
        id: "rewards-where",
        arrange: { closePanels: true, focus: () => "market_stall" },
        text: () => "Trong Quầy Chợ Echo có mục Phần thưởng Echo: đổi Đồng Echo lấy Premium 7 ngày, Phiếu AI hoặc khung hồ sơ.",
        target: () => world("market_stall"),
        expect: explain,
      },
      {
        id: "rewards-rule",
        text: () => "Giá, điều kiện và số lượt còn lại của từng phần thưởng hiện ngay trong bảng đó, đúng theo máy chủ. Đổi hay không là do bạn quyết định; hướng dẫn này không đổi gì thay bạn.",
        target: () => world("market_stall"),
        expect: explain,
      },
    ],
  },
  {
    id: "view",
    title: "Điều khiển camera và ngày/đêm",
    hint: "Di chuyển, thu phóng, đổi thời điểm",
    steps: [
      {
        id: "view-camera",
        arrange: { closePanels: true },
        dim: false,
        free: true,
        text: () => "Kéo để di chuyển, cuộn chuột hoặc chụm hai ngón tay để thu phóng. Các nút này phóng to, thu nhỏ và đưa bạn về góc nhìn mặc định.",
        target: () => dom("camera"),
        expect: explain,
      },
      {
        id: "view-time",
        dim: false,
        free: true,
        text: () => "Ba nút này đổi thời điểm ngắm đảo: Ban ngày, Hoàng hôn, Ban đêm. Đây chỉ là cách ngắm, thời gian trồng trọt không đổi. Hãy thử chọn một thời điểm khác nhé!",
        target: () => dom("time"),
        expect: () => "time",
      },
      {
        id: "view-sky",
        dim: false,
        free: true,
        text: () => "Bạn thấy không? Bầu trời, ánh sáng trên đảo, mặt trời, mặt trăng và đèn đêm cùng chuyển dần sang thời điểm mới.",
        target: () => dom("time"),
        expect: explain,
      },
    ],
  },
];

export function topicById(id: string): GuideTopic | null {
  return TOPICS.find((t) => t.id === id) ?? null;
}
