import { Guide } from '@/components/discover/Guide';
import { publicMetadata } from '@/lib/discover/metadata';

const path = '/huong-dan/nghe-chep-chinh-ta';
export const generateMetadata = () => publicMetadata(path);

export default function Page() {
  return <Guide path={path}>
    <p>Chép chính tả giúp bạn tìm đúng chỗ mình nghe hụt. Chuẩn bị giấy hoặc mở ghi chú. Nghe câu dưới đây một lần để nắm tình huống, rồi nghe lại và viết nguyên câu. Đánh dấu “?” ở vùng âm thanh chưa rõ.</p>
    <h2>Nghe và chép một lời nhắn</h2>
    <audio controls preload="none" aria-label="Câu tiếng Anh để luyện chép chính tả" src="/guides/library-books-v1.mp3" />
    <details className="my-5 rounded-xl border border-slate-600 p-4"><summary>Xem lời thoại sau khi chép</summary>
      <p lang="en">I left the books on the table by the window.</p><p>Tôi đã để mấy cuốn sách trên chiếc bàn cạnh cửa sổ.</p>
    </details>
    <h2>Khoanh vùng chỗ nghe hụt</h2>
    <ul><li>Nếu bạn chép <span lang="en">book</span>, nghe lại đoạn trước <span lang="en">on</span>. Cuối từ <span lang="en">books</span> có âm /s/. Nó cho biết có nhiều cuốn sách.</li>
      <li>Nếu thiếu mạo từ, nghe riêng cụm <span lang="en">on the table</span>. Từ <span lang="en">the</span> ngắn và nhẹ hơn âm đầu của <span lang="en">table</span>. Gõ nhịp vào từ được nhấn rồi chèn lại âm nhẹ.</li>
      <li>Nếu bạn nghe được từng từ nhưng vẫn hình dung sai, vẽ chiếc bàn cạnh cửa sổ rồi đặt sách lên bàn. Trong câu này, <span lang="en">by</span> chỉ vị trí.</li></ul>
    <h2>Kiểm tra lại mà không nhìn lời</h2>
    <p>Đóng lời thoại, đọc lại câu đã sửa và bật bản thu thêm một lần. Chọn đúng một lỗi để theo dõi ở câu tiếp theo, chẳng hạn âm cuối số nhiều. Bạn có thể tiếp tục với tài liệu của mình trong <a href="/listening">thư viện luyện nghe</a>.</p>
    <p>Nếu vướng ở nghĩa của một từ dù đã nghe đúng âm, hãy thử <a href="/huong-dan/hoc-tu-trong-ngu-canh">bài học từ trong ngữ cảnh</a>.</p>
  </Guide>;
}
