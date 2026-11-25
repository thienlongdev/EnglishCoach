import { Guide } from '@/components/discover/Guide';
import { publicMetadata } from '@/lib/discover/metadata';

const path = '/huong-dan';
export const generateMetadata = () => publicMetadata(path);

export default function Page() {
  return <Guide path={path}>
    <p>Chọn bài theo chỗ bạn đang vướng. Chuẩn bị giấy và bút để chép một câu nghe được hoặc ghi lại cách dùng của một từ mới.</p>
    <h2>Đọc thì hiểu nhưng nghe lại mất từ</h2>
    <p>Nếu bạn nghe ra danh từ chính nhưng bỏ sót từ ngắn hoặc đuôi số nhiều, hãy bắt đầu bằng một câu. Nghe, chép rồi so từng cụm để tìm chỗ âm thanh khác với điều bạn đoán.</p>
    <a href="/huong-dan/nghe-chep-chinh-ta">Thử bài nghe chép chính tả và đối chiếu lời thoại</a>
    <h2>Biết nghĩa của từ nhưng dịch cả câu vẫn sai</h2>
    <p>Một từ quen thuộc có thể đổi nghĩa khi đi với một danh từ khác. Thử suy ra nghĩa từ tình huống trước khi mở từ điển, rồi tự viết câu kiểm tra.</p>
    <a href="/huong-dan/hoc-tu-trong-ngu-canh">Phân biệt hai cách dùng của <span lang="en">charge</span></a>
  </Guide>;
}
