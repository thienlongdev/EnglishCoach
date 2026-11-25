// Learner-facing words of Word Chain. Every rule sentence must match WordChainRules / WordChainService / WordChainLexicon.
export type Pair = [string, string];

export const ERRORS: Record<string, Pair> = {
  WRONG_LETTER: ['Từ phải bắt đầu bằng chữ cái được yêu cầu.', 'The word must start with the required letter.'],
  SELF_DUPLICATE: ['Bạn đã dùng từ này trong ván. Hãy chọn từ khác.', 'You already played this word in this match.'],
  UNKNOWN_WORD: ['Không có từ tiếng Anh này trong từ điển của trò chơi.', 'This English word is not in the game dictionary.'],
  ABBREVIATION: ['Không chấp nhận từ viết tắt hoặc chữ viết tắt (như RAC, NATO, TV).', 'Abbreviations and acronyms (RAC, NATO, TV) are not allowed.'],
  PROPER_NOUN: ['Tên riêng (người, địa danh, tổ chức) không được tính.', 'Proper names (people, places, organisations) do not count.'],
  INVALID_FORM: ['Nhập một từ 2–40 chữ cái; chỉ có dấu nối hoặc dấu nháy ở giữa từ.', 'Enter one word of 2–40 letters; hyphens or apostrophes only inside the word.'],
  NOT_YOUR_TURN: ['Chưa đến lượt bạn.', 'It is not your turn.'],
  STALE_TURN: ['Lượt đã sang người khác trước khi từ của bạn tới máy chủ.', 'The turn moved on before your word reached the server.'],
  NOT_ACTIVE: ['Ván đã kết thúc hoặc chưa bắt đầu.', 'The match has ended or has not started.'],
  RATE_LIMITED: ['Bạn gửi quá nhanh. Đợi một chút rồi thử lại.', 'Too many attempts. Wait a moment and retry.'],
  INVALID_ROOM: ['Mã phòng gồm 8 ký tự (0–9, A–F). Kiểm tra lại mã.', 'A room code has 8 characters (0–9, A–F).'],
  ROOM_NOT_FOUND: ['Phòng không còn tồn tại. Bạn có thể tạo ván mới.', 'The room no longer exists. You can start a new match.'],
  ROOM_FULL: ['Phòng đã đủ người hoặc đã bắt đầu.', 'The room is full or already started.'],
  NOT_A_MEMBER: ['Bạn không thuộc phòng này.', 'You are not a member of this room.'],
  ALREADY_IN_ROOM: ['Bạn đang ở một phòng khác. Rời phòng đó trước.', 'You are in another room. Leave it first.'],
  STALE_SESSION: ['Ván đang mở ở thẻ khác. Tải lại trang để chơi ở đây.', 'The match is open in another tab. Reload to play here.'],
  CONNECTION_LOST: ['Mất kết nối. Đang kết nối lại — đồng hồ trên máy chủ vẫn chạy.', 'Connection lost. Reconnecting — the server clock keeps running.'],
  AUTH_REQUIRED: ['Phiên đăng nhập chưa sẵn sàng. Đăng nhập lại rồi thử.', 'Your sign-in session is unavailable. Sign in again.'],
  REQUEST_TIMEOUT: ['Chưa nhận được phản hồi. Đang lấy lại trạng thái; từ của bạn vẫn được giữ.', 'Response delayed. Refreshing state; your word is kept.'],
  RESULT_SAVING: ['Đang lưu kết quả. Đợi một chút.', 'Saving the result. One moment.'],
  DICTIONARY_UNAVAILABLE: ['Từ điển của trò chơi chưa sẵn sàng. Thử lại sau.', 'The game dictionary is unavailable. Try later.'],
  SERVER_BUSY: ['Các phòng đang đầy. Thử lại sau.', 'Rooms are at capacity. Try again later.'],
  SERVER_UNAVAILABLE: ['Chưa thực hiện được thao tác. Vui lòng thử lại.', 'The action could not be completed. Please retry.'],
  OPPONENT_LEFT: ['Đối thủ đã rời phòng. Về sảnh để tạo ván mới.', 'Your opponent left. Return to the lobby for a new match.'],
  HISTORY: ['Chưa mở được ván đã lưu.', 'The saved match could not be opened.'],
};

/** Codes a learner fixes by typing another word: they stay next to the composer, not in the page banner. */
export const WORD_ERRORS = new Set(['WRONG_LETTER', 'SELF_DUPLICATE', 'UNKNOWN_WORD', 'ABBREVIATION', 'PROPER_NOUN', 'INVALID_FORM', 'STALE_TURN', 'NOT_YOUR_TURN']);

export const ENDS: Record<string, Pair> = {
  TIMEOUT: ['Hết thời gian của lượt', 'The turn timer ran out'],
  GIVE_UP: ['Ván được dừng', 'The match was stopped'],
  FORFEIT: ['Một người chơi rời phòng', 'A player left the room'],
  DISCONNECT: ['Mất kết nối quá 15 giây', 'Disconnected for over 15 seconds'],
  BOT_NO_WORD: ['Echo không tìm được từ hợp lệ để nối', 'Echo found no valid word to connect'],
  CHAIN_LIMIT: ['Đạt giới hạn 200 lượt', 'Reached the 200-move limit'],
};

export const POS_LABEL: Record<string, Pair> = {
  noun: ['danh từ', 'noun'], verb: ['động từ', 'verb'], adjective: ['tính từ', 'adjective'], adverb: ['trạng từ', 'adverb'],
  conjunction: ['liên từ', 'conjunction'], pronoun: ['đại từ', 'pronoun'], preposition: ['giới từ', 'preposition'],
  interjection: ['thán từ', 'interjection'],
  // Results saved before 2026-10-29 carry the dictionary's one-letter codes.
  N: ['danh từ', 'noun'], V: ['động từ', 'verb'], A: ['tính từ', 'adjective'], D: ['trạng từ', 'adverb'], C: ['liên từ', 'conjunction'],
  P: ['đại từ', 'pronoun'], E: ['giới từ', 'preposition'], O: ['thán từ', 'interjection'],
};

export const MODE_LABEL: Record<string, Pair> = {
  SOLO: ['Luyện một mình', 'Solo practice'], BOT: ['Đấu với Echo Bot', 'Versus Echo Bot'],
  QUICK: ['Đấu nhanh ngẫu nhiên', 'Random quick match'], PRIVATE: ['Phòng bạn bè', 'Friends room'],
};

export const LEVEL_LABEL: Record<string, Pair> = {
  EASY: ['Dễ', 'Easy'], MEDIUM: ['Vừa', 'Medium'], HARD: ['Khó', 'Hard'],
};

export const t = (vi: boolean, pair: Pair | undefined) => (pair ? pair[vi ? 0 : 1] : '');
