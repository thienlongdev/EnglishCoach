import type { GuideDef } from '../types';
const t = (vi: string, en: string) => ({ vi, en });
export const ODYSSEY_GUIDES: GuideDef[] = [{
  id: 'odyssey', module: 'learningPath', level: 'feature', version: 2, path: '/learning-path',
  home: '/learning-path?view=odyssey', gate: '[data-guide="odyssey-map"]', offer: true,
  title: t('Khám phá Echo Odyssey', 'Explore Echo Odyssey'),
  summary: t('Hải đồ, trạm học và đường trở về.', 'The atlas, learning stations and the way back.'),
  steps: [
    { id: 'map', target: '[data-guide="odyssey-map"]', title: t('Một hành tinh học tập', 'A planet of learning'), body: t('Kéo để xoay hành tinh theo tay, thu phóng hoặc chọn tên vùng. Khám phá địa lý không cấp trình độ.', 'Drag to turn the planet, zoom or select a region. Geographic discovery does not award proficiency.') },
    { id: 'atlas', target: '[data-guide="odyssey-journey"]', title: t('Bản đồ hành trình', 'The journey atlas'), body: t('Mở Hành trình để xem toàn bộ lộ trình: nhánh kiến thức, kiến thức nền và bước tiếp theo.', 'Open Journey for the whole path: knowledge branches, prerequisites and your next step.') },
    { id: 'stations', target: '[data-guide="odyssey-stations"]', title: t('Chọn một trạm học', 'Choose a learning station'), body: t('Nhiệm vụ hôm nay dùng lộ trình hiện có. Trạm ngữ pháp mở đúng chủ đề của Học viện.', 'Daily quests use your existing plan. Grammar stations open the corresponding Academy topic.') },
    { id: 'quest', target: '[data-guide="odyssey-quest"]', title: t('Học và kiểm tra', 'Study and check'), body: t('Học bài và vượt kiểm tra là hai việc riêng. Nhánh nâng cao cần bằng chứng phù hợp.', 'Studying and passing a check are separate. Advanced branches need relevant evidence.'), waitMs: 1000 },
    { id: 'travel', target: '[data-guide="odyssey-travel-toggle"]', title: t('Đi thẳng đến nơi', 'Go straight there'), body: t('Mở Các đảo để chọn vùng. Bạn không cần di chuyển qua cả bản đồ trước khi học.', 'Open Islands to choose a region. You never need to cross the whole map to study.') },
    { id: 'list', target: '[data-guide="odyssey-list"]', title: t('Lộ trình dạng danh sách', 'The learning list'), body: t('Chọn Trở về để mở danh sách, đổi mục tiêu hoặc cập nhật Learner DNA.', 'Choose Exit for the learning list, goal changes or a Learner DNA update.') },
    { id: 'return', target: null, title: t('Mang kiến thức trở về', 'Bring learning back'), body: t('Trong bài học, chọn Trở về Echo Odyssey. Máy chủ đối chiếu kết quả đã lưu trước khi ghi dấu.', 'In an activity, choose Return to Echo Odyssey. The server checks saved results before recording a milestone.') },
  ],
}];
