import { Guide } from '@/components/discover/Guide';
import { publicMetadata } from '@/lib/discover/metadata';

const path = '/huong-dan/hoc-tu-trong-ngu-canh';
export const generateMetadata = () => publicMetadata(path);

export default function Page() {
  return <Guide path={path}>
    <p>Khi nghĩa đầu tiên trong từ điển khiến câu nghe vô lý, hãy nhìn vào người thực hiện hành động và thứ chịu tác động. Thử đoán nghĩa của động từ <span lang="en">charge</span> trong hai câu dưới đây trước khi mở đáp án.</p>
    <h2>Một động từ, hai tình huống</h2>
    <ul lang="en"><li>The café charges two dollars for an extra shot.</li><li>I charge my phone before the train leaves.</li></ul>
    <details className="my-5 rounded-xl border border-slate-600 p-4"><summary>Đối chiếu nghĩa và dấu hiệu trong câu</summary>
      <p>Quán cà phê tính thêm hai đô la cho một phần espresso. Số tiền và cụm <span lang="en">for an extra shot</span> gợi ý một khoản phí. Ở câu sau, người nói sạc điện thoại trước khi tàu chạy. Tân ngữ <span lang="en">my phone</span> gợi ý một thiết bị cần điện.</p>
    </details>
    <h2>Tạo một thẻ kiểm tra được cách dùng</h2>
    <p>Ở mặt trước, ghi tình huống “Khách sạn tính phí năm đô la cho bữa sáng” và câu khuyết <span lang="en">The hotel ___ five dollars for breakfast.</span> Ở mặt sau, ghi <span lang="en">charges</span>, gạch dưới số tiền và tự giải thích vì sao động từ có đuôi <span lang="en">-s</span>.</p>
    <p>Tách nghĩa “sạc pin” sang một thẻ riêng. Khi ôn lại, đổi điện thoại thành tai nghe và đặt câu mới. Một đáp án là <span lang="en">I charge my headphones after work.</span></p>
    <h2>Chuyển sang bài đọc của bạn</h2>
    <p>Chọn một câu có từ đa nghĩa. Che phần dịch, đoán nghĩa từ các từ đi kèm rồi tra lại đúng cụm. Nếu muốn dùng ngay trên trang đang đọc, xem <a href="/echo-anywhere">cách tra và lưu từ bằng Echo Anywhere</a>. Sau khi đăng nhập, bạn có thể ôn lại ở <a href="/flashcards">Thẻ từ vựng</a>.</p>
  </Guide>;
}
