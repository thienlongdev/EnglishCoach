import type { InspectableTarget } from "../EchoGardenCanvas";

/**
 * Inspect-panel content for every interactive element of the island.
 * Visual prototype only: no economy, timers, growth or rewards are implied as working.
 */
const PREVIEW_NOTE = { label: "Trạng thái", value: "Bản xem trước hình ảnh" };

const CROP_INFO: Record<string, { title: string; description: string; look: string }> = {
  wheat: {
    title: "Luống Lúa Mì",
    description: "Những bông lúa mì vàng óng đứng thẳng hàng trong luống gỗ, đung đưa theo gió nhẹ của hòn đảo.",
    look: "Lúa mì chín vàng",
  },
  watermelon: {
    title: "Luống Dưa Hấu",
    description: "Dây dưa bò kín luống, lá xanh mướt che hai trái dưa sọc tròn trịa và vài đóa hoa vàng nhỏ.",
    look: "Dưa hấu đang đậu trái",
  },
  tomato: {
    title: "Luống Cà Chua",
    description: "Bụi cà chua bám quanh cọc gỗ, những chùm quả đỏ mọng ẩn dưới tán lá.",
    look: "Cà chua chín đỏ",
  },
  strawberry: {
    title: "Luống Dâu Tây",
    description: "Những khóm dâu tây thấp, lá răng cưa xanh tươi, điểm quả đỏ và hoa trắng li ti.",
    look: "Dâu tây chín rộ",
  },
  pumpkin: {
    title: "Luống Bí Ngô",
    description: "Lá bí to bản trải rộng, nâng niu một trái bí ngô cam rực có múi rõ ràng.",
    look: "Bí ngô đã lớn",
  },
  corn: {
    title: "Luống Bắp",
    description: "Những thân bắp cao vút, lá dài cong mềm và bắp non vàng hạt lấp ló.",
    look: "Bắp đang trổ cờ",
  },
};

/** Visual growth stages (GDD 01 §4.2). Art only: no growth timer runs in this preview. */
const STAGE_LOOK: Record<number, string> = { 1: "Hình minh họa: mầm vừa nhú", 2: "Hình minh họa: cây non", 3: "Hình minh họa: đang ra hoa, kết trái" };

const CROP_NAME: Record<string, string> = {
  wheat: "lúa mì", watermelon: "dưa hấu", tomato: "cà chua", strawberry: "dâu tây", pumpkin: "bí ngô", corn: "bắp",
};

/** What the bed actually shows at an earlier visual stage (the species text describes stage 4). */
const STAGE_DESC: Record<number, (name: string) => string> = {
  1: (n) => `Những mầm ${n} vừa nhú trên các gò đất mới gieo.`,
  2: (n) => `Cây ${n} còn non, lá mới xòe rộng, chưa ra hoa.`,
  3: (n) => `Cây ${n} đã lớn, đang ra hoa và đậu những trái non đầu tiên.`,
};

export function cropTarget(plotId: string, index: number, crop: string, stage = 4): InspectableTarget {
  const info = CROP_INFO[crop] ?? CROP_INFO.wheat;
  const early = STAGE_DESC[stage];
  return {
    id: plotId,
    type: "crop",
    title: info.title,
    subtitle: `Ô đất khởi đầu #${index + 1} · Nông trại`,
    stage: STAGE_LOOK[stage] ?? info.look,
    description: `${early ? early(CROP_NAME[crop] ?? "trồng") : info.description} Việc gieo trồng và chăm sóc sẽ mở trong một giai đoạn sau.`,
    stats: [PREVIEW_NOTE, { label: "Khu vực", value: "6 ô đất khởi đầu" }],
  };
}

export const TARGETS: Record<string, InspectableTarget> = {
  farmhouse: {
    id: "farmhouse",
    type: "house",
    title: "Nhà Gỗ Ký Ức",
    subtitle: "Mái ấm của hòn đảo",
    description:
      "Ngôi nhà tường vôi khung gỗ, mái ngói đỏ và ống khói đá. Cửa sổ có hộp hoa nhỏ; khi chiều buông, ánh đèn vàng ấm áp sáng lên.",
    stats: [PREVIEW_NOTE, { label: "Khu vực", value: "Khoảng sân phía Bắc" }],
  },
  shed: {
    id: "shed",
    type: "house",
    title: "Kho Dụng Cụ",
    subtitle: "Bên rìa nông trại",
    description: "Căn kho ván gỗ mái xanh xám, cào cỏ dựa bên cửa và chiếc xô sắt đặt dưới hiên.",
    stats: [PREVIEW_NOTE],
  },
  prop_well: {
    id: "prop_well",
    type: "prop",
    title: "Giếng Đá",
    subtitle: "Quảng trường trung tâm",
    description: "Giếng đá cổ ở ngã tư các lối mòn — nơi những con đường tới nhà, ao, vườn và Cây Tri Thức gặp nhau.",
    stats: [PREVIEW_NOTE],
  },
  prop_lantern: {
    id: "prop_lantern",
    type: "prop",
    title: "Cột Đèn Gỗ",
    subtitle: "Lối vào nhà",
    description: "Chiếc đèn lồng sắt treo trên cột gỗ, thắp sáng lối về khi trời tối.",
    stats: [PREVIEW_NOTE],
  },
  prop_signpost: {
    id: "prop_signpost",
    type: "prop",
    title: "Cột Chỉ Đường",
    subtitle: "Ngã rẽ quảng trường",
    description: "Hai tấm biển gỗ chỉ về phía khu vườn và phía Cây Tri Thức.",
    stats: [PREVIEW_NOTE],
  },
  prop_scarecrow: {
    id: "prop_scarecrow",
    type: "prop",
    title: "Bù Nhìn Rơm",
    subtitle: "Cánh đồng phía Tây",
    description: "Bù nhìn đội nón rơm canh giữ những luống đất đã cày sẵn cho mùa vụ sau.",
    stats: [PREVIEW_NOTE],
  },
  farm_zone: {
    id: "farm_zone",
    type: "plot",
    title: "Nông Trại Khởi Đầu",
    subtitle: "6 ô đất đang canh tác",
    description:
      "Sáu luống gỗ nâng cao nằm giữa lối đi đất nện. Quanh đó là một thửa đã cày luống, đất bỏ hóa, những dải cỏ phủ đang nghỉ được cắm cọc đánh dấu, cùng góc chứa hạt giống và dụng cụ cạnh cổng — vùng đất để mở rộng trong các giai đoạn sau.",
    stats: [PREVIEW_NOTE, { label: "Ô đang canh tác", value: "6 ô" }],
  },
  knowledge_tree: {
    id: "knowledge_tree",
    type: "tree",
    title: "Cây Tri Thức",
    subtitle: "Đất Thiêng phía Đông Nam",
    stage: "Cổ thụ duy nhất của đảo",
    description:
      "Cổ thụ với thân bện từ năm nhánh gỗ xoắn, rễ chống ôm lấy đá, những cành lớn vươn ngang đỡ các tầng tán như mây và rễ khí buông xuống đất. Ánh sáng xanh dịu sống trong các khe vỏ cây và hốc lõi gỗ, nơi giữ những ký ức học tập; vài chữ cái khắc trên thân và thỉnh thoảng bay lên từ tán lá.",
    stats: [PREVIEW_NOTE, { label: "Số lượng", value: "Một cây duy nhất" }],
  },
  pond: {
    id: "pond",
    type: "prop",
    title: "Ao Ký Ức",
    subtitle: "Phía Tây Bắc hòn đảo",
    description: "Ao nước trong có cầu gỗ nhỏ, lá súng và rặng sậy ven bờ. Đàn cá koi bơi chậm rãi dưới mặt nước.",
    stats: [PREVIEW_NOTE, { label: "Đàn cá", value: "4 con koi" }],
  },
  forest_zone: {
    id: "forest_zone",
    type: "tree",
    title: "Rừng Ký Ức",
    subtitle: "Dải rừng phía Bắc",
    description: "Rừng sồi và thông xanh ôm lấy nhà gỗ, có lối mòn nhỏ dẫn vào giữa những tán cây.",
    stats: [PREVIEW_NOTE],
  },
  orchard_zone: {
    id: "orchard_zone",
    type: "tree",
    title: "Vườn Cây Ra Hoa",
    subtitle: "Đồng cỏ phía Đông",
    description: "Ba cây ăn trái nhỏ đang trổ hoa trên đồng cỏ đầy hoa dại.",
    stats: [PREVIEW_NOTE],
  },
  echo_whale: {
    id: "echo_whale",
    type: "whale",
    title: "Cá Voi Echo",
    subtitle: "Người bạn đồng hành",
    description: "Echo bơi giữa những tầng mây quanh hòn đảo, lúc lướt sau rặng rừng, lúc lượn ngang dưới chân núi đá.",
    stats: [PREVIEW_NOTE],
  },
  market_stall: {
    id: "market_stall",
    type: "prop",
    title: "Quầy Chợ Echo",
    subtitle: "Góc hạt giống cạnh cổng nông trại",
    description: "Thùng gỗ, bao hạt giống và thùng nước cạnh cổng: nơi Echo bày phân bón và các gói hạt đúng mùa mỗi ngày.",
    stats: [PREVIEW_NOTE],
  },
  forgotten_worm: {
    id: "forgotten_worm",
    type: "pest",
    title: "Sâu Quên Lãng",
    subtitle: "Ở rìa ruộng nghỉ",
    description:
      "Một chú sâu nhỏ đại diện cho những từ vựng sắp bị quên. Trong các giai đoạn sau, ôn tập thẻ từ sẽ giúp giữ khu vườn khỏe mạnh.",
    stats: [PREVIEW_NOTE],
  },
};

/** Focus point (grid) and relative zoom for districts / targets. */
export const FOCUS: Record<string, { gx: number; gy: number; zoom: number }> = {
  farm_zone: { gx: 8.8, gy: 18.8, zoom: 2.1 },
  knowledge_tree: { gx: 21.0, gy: 16.6, zoom: 1.75 },
  forest_zone: { gx: 12.0, gy: 3.8, zoom: 1.7 },
  farmhouse: { gx: 14.4, gy: 7.6, zoom: 2.2 },
  shed: { gx: 14.6, gy: 15.9, zoom: 2.3 },
  pond: { gx: 5.6, gy: 10.4, zoom: 2.2 },
  prop_well: { gx: 12.6, gy: 12.4, zoom: 2.4 },
  prop_lantern: { gx: 13.6, gy: 11.0, zoom: 2.4 },
  prop_signpost: { gx: 13.6, gy: 13.6, zoom: 2.4 },
  prop_scarecrow: { gx: 5.4, gy: 18.2, zoom: 2.3 },
  orchard_zone: { gx: 18.6, gy: 9.4, zoom: 2.0 },
  forgotten_worm: { gx: 5.6, gy: 20.6, zoom: 2.4 },
  market_stall: { gx: 12.0, gy: 16.2, zoom: 2.4 },
};

/** Phase 3C: a bed cell of a farmland region (gameplay opens its land card; the camera focuses the cell). */
export function landTarget(slot: number): InspectableTarget {
  return { id: `land_${slot}`, type: "plot", title: "Khu đất mới", subtitle: `Ô đất mở rộng #${slot}`, description: "" };
}

/** Phase 3A: a purchasable bed cell (gameplay opens the expansion card; the camera focuses the cell). */
export function expansionTarget(slot: number): InspectableTarget {
  return { id: `expand_${slot}`, type: "plot", title: "Luống mới", subtitle: `Ô đất mở rộng #${slot}`, description: "" };
}
