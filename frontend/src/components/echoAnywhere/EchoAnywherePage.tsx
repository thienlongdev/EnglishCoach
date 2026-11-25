import Link from 'next/link';
import { EchoAnywhereNav } from './EchoAnywhereNav';
import { HeroInstallLink, InstallPanel } from './InstallPanel';
import { HeroStage } from './HeroStage';
import styles from './echoAnywherePage.module.css';

const SITES = ['GitHub', 'Wikipedia', 'Reddit', 'Tài liệu kỹ thuật', 'Báo tiếng Anh', 'Blog', 'YouTube', 'TikTok Web', 'Facebook Web', 'Zalo Web'];

const FREE = [
  'Tra nghĩa Anh–Việt, IPA và phát âm cho từ, cụm từ, thành ngữ',
  'Dịch nhanh câu và đoạn đã chọn',
  'Lưu vào Thẻ từ vựng của tài khoản, không tạo thẻ trùng',
  'Mở từ trong Vũ trụ tri thức',
  'Đọc tập trung: cỡ chữ, giãn dòng, làm nổi đoạn, thước đọc, nền tối',
  'Bài tập cơ bản lấy đáp án từ chính đoạn văn, chấm chính xác',
  'Video Companion: câu có mốc thời gian, tua, lặp đoạn và phụ đề từ nguồn truy cập được',
  'Karaoke: chép chính tả, điền từ và xếp lại câu từ học liệu sẵn có',
  'Mục Đã lưu: tìm kiếm, ghi chú, nguồn trang',
];
const PREMIUM = [
  'Giải thích sâu: nghĩa trong ngữ cảnh, ngữ pháp, văn phong, thành ngữ',
  'Dịch theo ngữ cảnh và viết lại đơn giản hơn theo trình độ',
  'Hỏi Echo về đúng câu bạn đang đọc',
  'Hỏi về trích đoạn video hoặc lời nhạc được phép dùng: ngữ cảnh, tiếng lóng và nghĩa bóng',
  'Tóm tắt bài, từ vựng nên học, câu khó',
  'Quiz và bài tập AI, mỗi đáp án kèm trích dẫn từ bài',
];
const FAQ: [string, string][] = [
  ['Echo Anywhere có miễn phí không?', 'Có. Tra nghĩa, dịch nhanh, phát âm, lưu Thẻ từ vựng, đọc tập trung và bài tập cơ bản đều miễn phí. Các tính năng Echo AI cần gói Premium của English Coach và có giới hạn sử dụng hằng tháng.'],
  ['Tôi có cần tài khoản không?', 'Tra nghĩa, dịch nhanh và đọc tập trung dùng được ngay. Để lưu Thẻ từ vựng, đồng bộ và dùng Echo AI, bạn kết nối tiện ích với tài khoản English Coach trong vài giây.'],
  ['Echo có đọc mọi trang tôi mở không?', 'Không. Mặc định Echo chỉ chạy trên một trang khi bạn gọi nó (bấm biểu tượng, chuột phải hoặc phím tắt). Bạn có thể cho phép Echo tự hiện khi bôi đen chữ trên từng trang bạn chọn, và thu hồi bất cứ lúc nào.'],
  ['Echo có gửi tin nhắn riêng của tôi đi đâu không?', 'Bản 1.0.1 yêu cầu đồng ý theo phạm vi trước khi gửi nội dung riêng. Quyền tra từ trên bảng tin tách khỏi hội thoại riêng, lưu từ, Vũ trụ tri thức và AI; có thể thu hồi trong cài đặt. Văn bản riêng được chọn không kèm câu xung quanh. Nếu trình duyệt còn ở bản 1.0.0, hãy tự dán đúng phần muốn chia sẻ vào ô Tra nghĩa trong lúc chờ cập nhật.'],
  ['Đang dùng 1.0.0, tôi có cần cài lại không?', 'Không. Với bản cài từ Chrome Web Store, trình duyệt tự tải và áp dụng bản cập nhật khi tiện ích rảnh; có thể đến dần. Giữ nguyên tiện ích để giữ kết nối tài khoản, cài đặt và từ đã lưu. Website chỉ xác nhận phiên bản khi tiện ích phản hồi, không thể ép cập nhật ngay.'],
  ['Video YouTube nào cũng có phụ đề song ngữ sao?', 'Không. Echo dùng phụ đề truy cập được hoặc các dòng có mốc thời gian trong bản chép lời bạn mở. Hãy mở bản chép lời trên YouTube rồi chọn “Đọc bản chép lời đang mở”. Nếu nguồn bị hạn chế, dùng tệp SRT/VTT hoặc đoạn văn bạn có quyền sử dụng. Bản dịch Việt tùy nguồn có sẵn và khả năng dịch được hỗ trợ.'],
  ['Echo có tự lấy mọi lời bài hát trên Spotify không?', 'Không. Lyrics Lab dùng trích đoạn tiếng Anh bạn có quyền sử dụng, phụ đề truy cập được hoặc nội dung bạn tự cung cấp. Không có kho lời nhạc được cấp phép hay cam kết trích lời từ Spotify.'],
  ['Có dùng được trên điện thoại không?', 'Chưa. Echo Anywhere dành cho Chrome, Brave, Cốc Cốc và Edge tương thích trên máy tính.'],
  ['Dùng Echo khi làm bài thi trên English Coach được không?', 'Không. Echo Anywhere không chạy trên English Coach, kể cả phòng thi và trò chơi xếp hạng, để giữ công bằng cho mọi người.'],
];

export function EchoAnywherePage() {
  return (
    <div className={styles.page} data-discover-document="">
      <EchoAnywhereNav />

      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>Tiện ích trình duyệt · Máy tính</p>
          <h1 className={styles.title}>Echo Anywhere</h1>
          <p className={styles.lead}>Gặp tiếng Anh ở đâu, học ngay ở đó. Từ trang đang đọc đến bản chép lời video truy cập được và trích đoạn lời nhạc — tra từ, luyện nghe và lưu kiến thức vào English Coach ngay trong ngữ cảnh.</p>
          <div className={styles.heroCtas}>
            <HeroInstallLink />
            <a className={styles.ghostBtnLight} href="#cach-dung">Xem cách dùng</a>
          </div>
          <ul className={styles.siteRow} aria-label="Dùng được trên">
            {SITES.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>
        <HeroStage />
      </header>

      <div>
        <section className={styles.section} id="cach-dung" aria-labelledby="h-how">
          <h2 id="h-how" className={styles.h2}>Học ngay trên trang bạn đang đọc</h2>
          <p className={styles.sectionLead}>Biến nội dung tiếng Anh truy cập được trên trình duyệt thành trải nghiệm học tương tác. Bài báo, mạng xã hội, website giáo dục và tài liệu kỹ thuật — Echo xuất hiện khi bạn cần trên những trang được hỗ trợ.</p>
          <div className={`${styles.grid3} ${styles.reveal}`}>
            <Feature title="Bôi đen, rồi hỏi Echo" text="Một thanh công cụ nhỏ cạnh đoạn bạn chọn: Tra nghĩa, Dịch, Phát âm, Giải thích, Ngữ pháp, Lưu Flashcard, Luyện tập, Vũ trụ tri thức, Hỏi Echo AI. Hoặc chuột phải → “Echo”, hoặc Alt+Shift+E." />
            <Feature title="Từ điển hiểu ngữ cảnh" text="Nghĩa Anh–Việt theo từ loại, IPA, đồng nghĩa, trái nghĩa, collocation, cụm động từ — từ cùng bộ từ điển của English Coach. Echo cho thấy câu chứa từ để bạn chọn đúng nghĩa." />
            <Feature title="Đọc thoải mái hơn" text="Đọc tập trung trên một lớp riêng: cỡ chữ, giãn dòng, làm nổi đoạn đang đọc, thước đọc, nền sáng / sepia / tối. Đóng lại là trang gốc y nguyên." />
            <Feature title="Echo Video Companion" text="Học từ bản chép lời YouTube truy cập được và phụ đề của trình phát được hỗ trợ. Theo từng câu có mốc thời gian, bấm để tua, dịch câu, lặp đoạn và khám phá từ vựng. Trên YouTube, mở bản chép lời rồi chọn “Đọc bản chép lời đang mở”." />
            <Feature title="Phụ đề Anh–Việt" text="Đọc hai ngôn ngữ từ phụ đề có sẵn, bản dịch được phép hoặc tệp SRT/VTT bạn cung cấp. Ưu tiên phụ đề Việt sẵn có; chỉ dịch những câu cần dùng. Khả năng này tùy nguồn phụ đề, không có trên mọi video YouTube." />
            <Feature title="Echo Lyrics Lab" text="Khám phá phát âm, tiếng lóng và nghĩa bóng trong trích đoạn lời nhạc tiếng Anh bạn có quyền sử dụng. Premium hỗ trợ giải thích sâu khi bạn yêu cầu. Với trình phát không truy cập được, tự dán đoạn được phép dùng; không tự lấy mọi lời nhạc Spotify." />
            <Feature title="Karaoke và luyện nghe" text="Chép chính tả, điền từ còn thiếu, xếp lại câu và kiểm tra hiểu nội dung bằng học liệu sẵn có. Tua và lặp đoạn để nghe lại theo nhịp của bạn. Thu giọng để nghe lại là tùy chọn trên thiết bị, không phải điểm đánh giá Speaking." />
            <Feature title="Echo AI khi bạn cần" text="Người học Premium có thể yêu cầu giải thích ngữ cảnh, tóm tắt trích đoạn và hỏi về câu đang học. Tận dụng từ điển, bản dịch đã có và xử lý cục bộ trước; bôi đen, cuộn hoặc mở bảng không tự gọi AI." />
            <Feature title="Chủ động và riêng tư" text="Kiểm tra nguồn tiếng Anh trước khi gửi; giải thích vẫn bằng tiếng Việt. Nội dung riêng cần sự đồng ý đúng phạm vi. Bạn quyết định trang nào được dùng, đoạn nào được chia sẻ và có thể thu hồi quyền." />
          </div>
        </section>

        <section className={styles.sectionAlt} aria-labelledby="h-sync">
          <div className={`${styles.split} ${styles.reveal}`}>
            <div>
              <h2 id="h-sync" className={styles.h2}>Nối thẳng vào việc học của bạn</h2>
              <p className={styles.sectionLead}>Mỗi từ bạn lưu đi vào Thẻ từ vựng của tài khoản và được ôn theo lịch như mọi thẻ khác. Bấm “Vũ trụ tri thức” để thấy từ đó giữa các từ liên quan bạn đã học.</p>
              <ul className={styles.ticks}>
                <li>Lưu một lần, ôn trên English Coach ở mọi thiết bị</li>
                <li>Chống thẻ trùng: lưu lại một từ đã có sẽ không tạo thẻ mới</li>
                <li>Giữ câu ví dụ nơi bạn gặp từ, cùng tên và địa chỉ trang</li>
                <li>Giải thích AI theo trình độ của bạn trên English Coach</li>
              </ul>
            </div>
            <div className={styles.panelIllustration} aria-hidden="true">
              <div className={styles.miniCard}><b>postpone</b><span>/pəˈspəʊn/ · hoãn</span><em>“They postponed the vote…”</em><span className={styles.miniSaved}>Đã lưu vào Thẻ từ vựng</span></div>
              <div className={styles.miniStars}><span /><span /><span /><span /><span /></div>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="h-tiers">
          <h2 id="h-tiers" className={styles.h2}>Miễn phí và Premium</h2>
          <p className={styles.sectionLead}>Echo Anywhere hữu ích ngay cả khi bạn không trả phí. Echo AI dùng chung gói Premium của English Coach.</p>
          <div className={`${styles.grid2} ${styles.reveal}`}>
            <div className={styles.tier}>
              <h3 className={styles.h3}>Miễn phí</h3>
              <ul className={styles.ticks}>{FREE.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
            <div className={`${styles.tier} ${styles.tierPro}`}>
              <h3 className={styles.h3}>Premium <span className={styles.badge}>Echo AI</span></h3>
              <ul className={styles.ticks}>{PREMIUM.map((x) => <li key={x}>{x}</li>)}</ul>
              <p className={styles.small}>Echo AI chỉ chạy khi bạn bấm, có giới hạn sử dụng hằng tháng, và không dùng lượt AI miễn phí hằng ngày của trang web.</p>
              <Link className={styles.ghostBtn} href="/premium">Xem gói Premium</Link>
            </div>
          </div>
        </section>

        <section className={styles.sectionAlt} id="cai-dat" aria-labelledby="h-install">
          <h2 id="h-install" className={styles.h2}>Cài đặt</h2>
          <InstallPanel />
          <ol className={styles.steps}>
            <li><b>Cài tiện ích</b> từ cửa hàng tiện ích của trình duyệt.</li>
            <li><b>Ghim biểu tượng Echo</b>: bấm biểu tượng mảnh ghép cạnh thanh địa chỉ, ghim “Echo Anywhere”.</li>
            <li><b>Kết nối tài khoản</b>: bấm Echo → “Kết nối tài khoản”, đăng nhập English Coach, bấm “Kết nối”.</li>
            <li><b>Bôi đen chữ tiếng Anh</b> trên một trang được hỗ trợ rồi bấm biểu tượng Echo, hoặc nhấn Alt+Shift+E. Để học video, mở “Video, lời nhạc và Karaoke” trong bảng Echo.</li>
          </ol>
        </section>

        <section className={styles.section} id="quyen-rieng-tu" aria-labelledby="h-privacy">
          <h2 id="h-privacy" className={styles.h2}>Quyền riêng tư và quyền truy cập</h2>
          <div className={`${styles.grid2} ${styles.reveal}`}>
            <div>
              <h3 className={styles.h3}>Echo làm gì</h3>
              <ul className={styles.ticks}>
                <li>Chỉ chạy trên một trang khi bạn gọi, hoặc trên những trang bạn đã cho phép tự hiện</li>
                <li>Gửi đoạn được chọn khi bạn bấm tra, dịch, lưu hoặc AI; phân tích bài gửi tối đa 12.000 ký tự của bài bạn chủ động chọn</li>
                <li>Lưu Thẻ từ vựng vào tài khoản của bạn; ghi chú và nguồn trang (không kèm tham số) lưu trên trình duyệt</li>
                <li>Kết nối bằng một phiên riêng, xem và ngắt được ở Hồ sơ cá nhân → Phiên đăng nhập</li>
              </ul>
            </div>
            <div>
              <h3 className={styles.h3}>Echo không làm gì</h3>
              <ul className={styles.crosses}>
                <li>Không theo dõi lịch sử duyệt web, không ghi phím gõ</li>
                <li>Không đọc ô nhập liệu, mật khẩu hay thông tin thanh toán</li>
                <li>Không tự gửi trang, tin nhắn riêng hay đoạn văn nào khi bạn chưa bấm</li>
                <li>Không thấy mật khẩu hay cookie đăng nhập của bạn</li>
                <li>Không chạy trên English Coach, kể cả phòng thi và trò chơi xếp hạng</li>
              </ul>
            </div>
          </div>
          <p className={styles.small}>Tra từ và luyện tập tận dụng từ điển, phụ đề, bản dịch đã có và xử lý cục bộ. Dịch trên thiết bị cần trình duyệt và gói ngôn ngữ tương thích; khi dùng dịch qua mạng, những câu cần dịch đi qua máy chủ English Coach tới dịch vụ dịch máy. Echo AI (Premium) chỉ xử lý phần bạn chủ động yêu cầu qua máy chủ English Coach tới nhà cung cấp mô hình AI. Văn bản trang web luôn là dữ liệu, không phải lệnh.</p>
          <p className={styles.small}>Dữ liệu được xử lý gồm định danh tài khoản, phiên riêng của tiện ích và nội dung bạn gửi. Bản 1.0.1 kiểm tra nguồn tiếng Anh trước khi truyền; hỏi đồng ý theo tài khoản, trang, tab và loại nội dung riêng. Quyền tra từ trên bảng tin tách khỏi hội thoại, lưu từ, Vũ trụ tri thức và AI; quyền nhớ trong phiên trình duyệt hết hạn sau tối đa tám giờ và có thể thu hồi. Lựa chọn trong hội thoại riêng không gửi kèm câu xung quanh. Nếu còn dùng 1.0.0, hãy tự dán đúng đoạn muốn chia sẻ vào ô Tra nghĩa trong lúc chờ trình duyệt cập nhật.</p>
          <p className={styles.small}>Mục Đã lưu giữ tên trang và địa chỉ nguồn không kèm query/hash trên thiết bị, chỉ cho các mục bạn lưu; không thu thập mọi trang bạn truy cập. Tệp phụ đề và trích đoạn lời nhạc phải là nội dung bạn có quyền sử dụng. Thu giọng luyện nghe là tùy chọn, xử lý trên thiết bị.</p>
          <p className={styles.small}>Không bán dữ liệu hoặc dùng dữ liệu để quảng cáo hay quyết định tín dụng. Nội dung cần thiết chỉ được chuyển để cung cấp chức năng bạn yêu cầu. Nhà cung cấp dịch máy và AI có chính sách xử lý riêng; không gửi nội dung nhạy cảm nếu bạn không muốn nội dung đó được xử lý bởi dịch vụ bên ngoài.</p>
          <p className={styles.small}>Bạn có thể xóa mục Đã lưu trong tiện ích, quản lý/xóa Thẻ từ vựng trên English Coach, thu hồi quyền website trong cài đặt trình duyệt và ngắt phiên Echo Anywhere tại Hồ sơ cá nhân → Phiên đăng nhập. Phiên có giới hạn không hoạt động 14 ngày và thời hạn tối đa 30 ngày. Để yêu cầu hỗ trợ về dữ liệu, dùng <Link href="/dashboard?feedback=open">Gửi phản hồi và báo lỗi</Link> sau khi đăng nhập. Chính sách Echo Anywhere cập nhật ngày 17/11/2026.</p>
        </section>

        <section className={styles.sectionAlt} aria-labelledby="h-limits">
          <h2 id="h-limits" className={styles.h2}>Những gì Echo chưa làm được</h2>
          <ul className={`${styles.limits} ${styles.reveal}`}>
            <li>Dành cho Chrome, Brave, Edge và phiên bản Cốc Cốc tương thích trên máy tính (Chromium 116 trở lên); chưa có bản cho điện thoại. Việc cài đặt phụ thuộc hỗ trợ và chính sách của từng trình duyệt.</li>
            <li>Không đọc chữ từ điểm ảnh của video, hình ảnh hay khung được bảo vệ. Video Companion cần phụ đề hoặc bản chép lời truy cập được; với TikTok Web, Zalo Web, Facebook Web, tra từ chỉ dùng chữ bạn chọn được.</li>
            <li>Trình duyệt không cho tiện ích chạy trên trang hệ thống, cửa hàng tiện ích và một số trình xem PDF — khi đó hãy dán đoạn văn vào bảng Echo.</li>
            <li>Dịch nhanh miễn phí là dịch máy, có thể chưa đúng sắc thái; AI cũng có thể sai, hãy đối chiếu khi cần.</li>
            <li>Kết quả luyện tập trong Echo không tính vào bài thi, hồ sơ năng lực hay bảng xếp hạng.</li>
          </ul>
        </section>

        <section className={styles.section} id="cau-hoi" aria-labelledby="h-faq">
          <h2 id="h-faq" className={styles.h2}>Câu hỏi thường gặp</h2>
          <div className={styles.faq}>
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
          <p className={`${styles.small} ${styles.faqSupport}`}>Cần hỗ trợ thêm? <Link href="/dashboard?feedback=open">Gửi phản hồi và báo lỗi cho English Coach</Link> (cần đăng nhập).</p>
        </section>
      </div>

      <footer className={styles.footer}>
        <span>© English Coach · Echo Anywhere</span>
        <Link href="/">Trang chủ</Link>
        <Link href="/huong-dan/hoc-tu-trong-ngu-canh">Cách học từ trong ngữ cảnh</Link>
        <Link href="/premium">Premium</Link>
      </footer>
    </div>
  );
}

function Feature({ title, text }: { title: string; text: string }) {
  return (
    <div className={styles.feature}>
      <h3 className={styles.h3}>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
