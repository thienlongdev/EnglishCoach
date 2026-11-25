# Echo Anywhere — store listing and submission pack (Chrome Web Store, Microsoft Edge Add-ons)

Last verified: 2026-11-17 ICT · uncommitted codex/exams-corpus-production (unborn HEAD) · submitted 1.0.1 ZIP f3b0e839 · live frontend fd6a0b09, backend a244f7e8 and Nginx df221db8. The [Chrome Web Store listing](https://chromewebstore.google.com/detail/echo-anywhere-%E2%80%94-english-c/gohhmbiobjnfnkagkklffajggkmgegod) serves version 1.0.0. Google confirmed submission of 1.0.1 for review on 2026-11-17 ICT. Automatic publication after approval is selected; approval is not yet verified.

Chrome developer item: https://chrome.google.com/webstore/devconsole/5c07d9b9-77b6-47d9-ae05-cb0f6b972df9/gohhmbiobjnfnkagkklffajggkmgegod/edit/listing
Home: https://englishcoach.io.vn/echo-anywhere · Support: https://englishcoach.io.vn/echo-anywhere#cau-hoi · Privacy: https://englishcoach.io.vn/echo-anywhere#quyen-rieng-tu

Packages (built by `node build.mjs` in `extension/echo-anywhere`, no `key` field — the stores assign their own id):

- Chrome handoff: `dist/store/echo-anywhere-chrome-1.0.1.zip`. Public version: 1.0.0.
- Microsoft Edge Add-ons: `dist/store/echo-anywhere-edge-1.0.0.zip`
- Development / testing (unpacked, pinned id `kfepndgiddgljieglnilcaadlcgmdghj`): `dist/unpacked/`, `dist/store/echo-anywhere-dev-unpacked-1.0.0.zip`

## 1.0.1 listing copy and reviewer pack

**Name:** Echo Anywhere — English Coach

**Category:** Education (Chrome: "Education"; Edge: "Education")

**Language:** Vietnamese (primary), English

**Short description (≤ 132 chars):**
Học tiếng Anh ngay trên mọi trang web: tra nghĩa theo ngữ cảnh, phát âm, lưu Thẻ từ vựng English Coach.

**Detailed description:**

Echo Anywhere đưa trợ lý Echo của English Coach tới trang bạn đang đọc. Bôi đen một từ, cụm từ hay câu tiếng Anh trên GitHub, Wikipedia, tài liệu kỹ thuật, báo, blog… rồi bấm biểu tượng Echo (hoặc chuột phải → “Echo”, hoặc Alt+Shift+E).

Miễn phí:
• Tra nghĩa Anh–Việt theo từ loại, IPA, phát âm, từ đồng nghĩa / trái nghĩa, collocation, cụm động từ, thành ngữ
• Câu bạn đang đọc được hiện kèm để chọn đúng nghĩa; dịch nhanh câu và đoạn
• Lưu vào Thẻ từ vựng của tài khoản English Coach (không tạo thẻ trùng) và ôn theo lịch trên English Coach
• Mở từ trong Vũ trụ tri thức
• Đọc tập trung: cỡ chữ, giãn dòng, làm nổi đoạn, thước đọc, nền sáng / sepia / tối — trang gốc không bị thay đổi
• Bài tập cơ bản lấy đáp án từ chính đoạn văn, chấm chính xác
• Mục Đã lưu với ghi chú và nguồn trang
• Kiểm tra tiếng Anh trên thiết bị. Quyền tra từ trong bảng tin tách riêng với hội thoại, lưu thẻ và AI. Thu hồi trong Cài đặt.
• Video và lời dùng phụ đề trình phát cho phép truy cập hoặc SRT/VTT bạn có quyền dùng. Có thể lặp câu, chỉnh tốc độ, điền từ, chép chính tả, xếp câu và thu giọng để tự nghe lại.
• Echo Lyrics Lab giúp hiểu trích đoạn tiếng Anh được phép sử dụng. Với trình phát không cung cấp chữ, bạn có thể tự nhập văn bản.

Premium (gói Premium của English Coach, giới hạn sử dụng hằng tháng):
• Giải thích sâu: nghĩa trong ngữ cảnh, ngữ pháp, văn phong, thành ngữ, cách nói tự nhiên hơn
• Dịch theo ngữ cảnh, viết lại đơn giản hơn theo trình độ, ví dụ mới
• Hỏi Echo về đúng câu bạn đang đọc
• Tóm tắt bài, từ vựng nên học, câu khó; quiz và bài tập AI kèm trích dẫn bằng chứng từ bài

Quyền riêng tư: Echo chỉ chạy trên một trang khi bạn gọi nó, hoặc trên những trang bạn cho phép tự hiện. Echo không theo dõi lịch sử duyệt web, không ghi phím gõ, không đọc ô nhập liệu, mật khẩu hay thông tin thanh toán. Chỉ nội dung bạn chủ động chọn và bấm gửi được xử lý; phân tích bài gửi tối đa 12.000 ký tự. Chính sách: https://englishcoach.io.vn/echo-anywhere#quyen-rieng-tu

Echo Anywhere dành cho Chrome và Microsoft Edge trên máy tính.

## Single purpose (Chrome)

Help a learner understand and keep English words and passages they meet on web pages, linked to their English Coach account.

## Permission justifications

The final manifest matches 1.0.0 except for version. Microphone practice requests device access after the learner presses Record. No host permission expansion, tabCapture, offscreen document or remote executable code.

| Permission | Why |
|---|---|
| `activeTab` | Read the text the learner selected on the tab where they pressed Echo (toolbar, context menu, shortcut) — only after that press. |
| `scripting` | Inject the Echo selection toolbar / reading overlay into that tab after the learner's press, or on sites the learner granted. |
| `contextMenus` | “Echo: Tra nghĩa / Dịch / Lưu / Đọc tập trung” on a selection. |
| `storage` | Settings, the learner's “Đã lưu” list (notes, page title, address without query string) and the extension's own sign-in on this device. |
| `sidePanel` | The Echo panel (Tra nghĩa, Khám phá, Luyện tập, Đã lưu). |
| Host `https://englishcoach.io.vn/*` | The English Coach API (dictionary, saving cards, Premium AI) and the account-connection page. |
| Optional hosts `https://*/*`, `http://*/*` | Requested only when the learner turns on “Tự hiện Echo khi bôi đen chữ” for a site (or for all sites) in the popup / settings; revocable there. |

No remote code: every script is in the package; extension pages use `script-src 'self'`.

## Data disclosure (Chrome "Privacy practices" / Edge "Privacy")

- The English gate, cue synchronization, imported subtitles, exercise grading and microphone recordings run locally. Remote data includes explicitly studied vocabulary, its permitted context, requested article text and, in bilingual mode, active English lines needing machine translation. Premium media explanations send only an explicitly requested excerpt. The companion does not upload audio, archive full lyrics or send full transcripts. Scoped session grants and count-only practice progress stay on the device.
- Account: the extension's own English Coach session (a revocable sign-in, listed as "Echo Anywhere" in the account's session list). No password, no website cookie.
- Not collected: browsing history, keystrokes, form contents, passwords, payment data, location, health data.
- Not sold, not used for advertising or credit decisions, not transferred except to process the request (English Coach servers; the machine-translation service for free quick translation; the AI model provider for Premium AI).
- Website and privacy policy: https://englishcoach.io.vn/echo-anywhere

Saved Chrome declarations: personally identifiable information, authentication information, personal communications (only explicitly submitted text), web history (only the saved source title/URL), website content. These broad Google categories include the user-requested saved source URL; they do not imply passive history tracking. Health, financial, location and activity tracking categories are unchecked. All three limited-use certifications checked. Distribution declares in-app purchases because optional AI uses the external English Coach Premium plan.

Reviewer instructions for the earlier 1.0.0 submission (historical):
> No login: open an English Wikipedia article; click Echo, select oxygen, choose Tra nghĩa; test pronunciation and Đọc tập trung (Escape exits). For account features, use the supplied English Coach login: Kết nối tài khoản → sign in on the website → approve PKCE pairing; save a word and check Flashcards; revoke in Profile → Sessions. AI requires active Premium and quota; free accounts must be refused. Protected pages and English Coach block overlays. Optional website access is revocable.

The owner entered and explicitly authorized sharing the reviewer login with Google. Credentials are kept only in the store form, never in this pack. Premium entitlement of that account was not inspected.

## Screenshots to upload

Uploaded and saved in the existing Chrome item:

| Asset | File | Size / provenance |
|---|---|---|
| Store icon | `assets/icon-128.png` | 128 × 128, original product icon |
| Dictionary light | `assets/01-dictionary-light.png` | 1280 × 800 RGB, real local QA `21-card-light.png` |
| Dictionary dark | `assets/02-dictionary-dark.png` | 1280 × 800 RGB, real local QA `21-card-dark.png` |
| Focus reading | `assets/03-focus-reading.png` | 1280 × 800 RGB, real local QA `12-reader.png` |
| Small promo | `assets/promo-small.png` | 440 × 280 RGB, generated brand artwork |
| Marquee | `assets/promo-marquee.png` | 1400 × 560 RGB, generated brand artwork |

Screenshots depict genuine extension UI on Wikipedia in the previous release's local QA stack, not newly captured production UI. Only proportional resizing and RGB export were applied, without invented controls or results. `prepare-assets.py` records exact sources. Generated promotion uses the original Echo mascot reference `src/icons/echo-256.webp`; it is separate from product screenshots.

Promotional prompt set: Echo Anywhere / English Coach browser-extension artwork, official friendly blue Echo whale based on the supplied mascot reference, deep ocean blue background, pearl glass English-word motifs, crisp legible product name, spacious composition, no fabricated interface, store badges, ratings, testimonials or approval claims. Small tile: compact 11:7 composition, Echo Anywhere and English Coach text. Marquee: wide 5:2 composition, Echo Anywhere, English Coach, “Learn English wherever you read”, matching blue ocean / pearl lighting. Final exports use the store's required dimensions above.

## Final 1.0.1 update submitted to Google

Description addition: open the video companion and the learner-visible YouTube transcript; seek, look up, loop or practise from real timed lines. Availability varies by player. Prefer native Vietnamese captions and on-device translation when available. Bounded explicit Premium assistance and optional local-only microphone practice. No new permissions or remote scripts.

Fourth store screenshot: `assets/04-video-learning.png`, 1280 × 800; actual extension UI with an authorized bilingual test clip, not a live YouTube claim.

Reviewer instructions supplied (472 characters, no credentials): No login: open a captioned YouTube watch page, expand the description and select Show transcript. Open Echo > Video, lời nhạc và Karaoke > Đọc bản chép lời đang mở. Select a timestamp, look up a word, translate, replay, or try dictation. On an HTML5 page, use native captions or import your own SRT/VTT. Account features: connect via the English Coach website, save a flashcard, then revoke in Profile > Sessions. AI requires an active Premium account and explicit action.

## Distribution

Submitted Chrome ZIP: 398,454 bytes, SHA-256 `f3b0e839e96c71973bb7823764e62808d861c1d547dcb0cca8697904b7db9a2e`. Google confirmed receipt for review, with auto-publication after approval. The updated description, fourth screenshot, privacy-purpose explanation and reviewer instructions were supplied in the existing item. Edge Add-ons remains unpublished.
