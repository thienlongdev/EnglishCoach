package com.englishcoach.speaking.service;

import java.util.List;
import java.util.Map;

/**
 * Provides maintainable Vietnamese instructional localization for system Role-play scenarios.
 * Learning targets (vocabulary, grammar, initial AI message, title) remain English,
 * while instructional prose (context description, learner mission, success criteria, hints)
 * is naturally localized for Vietnamese learners.
 */
public final class SpeakingScenarioLocalization {

    private SpeakingScenarioLocalization() {}

    public record LocalizedContent(
            String description,
            String learnerGoal,
            List<String> successCriteria,
            List<String> optionalHints
    ) {}

    private static final Map<String, LocalizedContent> SYSTEM_LOCALIZATIONS = Map.of(
            "Airport Immigration & Customs Declaration", new LocalizedContent(
                    "Thực hiện thủ tục nhập cảnh khi hạ cánh tại sân bay quốc tế, trả lời các câu hỏi về mục đích chuyến đi và thời gian lưu trú.",
                    "Nêu rõ mục đích và thời gian chuyến đi, cung cấp thông tin nơi lưu trú và khai báo hành lý cá nhân.",
                    List.of(
                            "Nêu rõ mục đích cụ thể (du lịch/công tác/du học) một cách tự tin, rõ ràng",
                            "Xác định rõ thời gian lưu trú và ngày bay về",
                            "Cung cấp rõ tên khách sạn hoặc địa chỉ nơi lưu trú"
                    ),
                    List.of(
                            "Trả lời ngắn gọn, trực diện và đúng trọng tâm, tránh giải thích dài dòng không cần thiết.",
                            "Sử dụng các mẫu câu như 'I'm here for tourism for two weeks'."
                    )
            ),
            "Hotel Check-in & Room Preferences", new LocalizedContent(
                    "Làm thủ tục nhận phòng đã đặt trước tại khách sạn Grand Horizon, yêu cầu phòng yên tĩnh ở tầng cao và hỏi về giờ ăn sáng cùng thông tin WiFi.",
                    "Hoàn tất thủ tục nhận phòng đã đặt, xác nhận thời gian phục vụ bữa sáng và yêu cầu phòng yên tĩnh ở tầng cao.",
                    List.of(
                            "Xác nhận thông tin đặt phòng theo tên của bạn",
                            "Đưa ra yêu cầu phòng yên tĩnh hoặc tầng cao một cách lịch sự",
                            "Hỏi về lịch phục vụ bữa sáng và thông tin đăng nhập Wi-Fi"
                    ),
                    List.of(
                            "Sử dụng các câu hỏi gián tiếp lịch sự như 'Could you please tell me...'",
                            "Nếu được đề xuất nâng hạng phòng, hãy hỏi xem có miễn phí không (complimentary)."
                    )
            ),
            "Ordering at a Specialty Coffee Shop", new LocalizedContent(
                    "Đến quầy gọi đồ tại một quán cà phê phong cách thủ công, gọi đồ uống theo sở thích riêng cùng bánh ngọt và thanh toán bằng thẻ.",
                    "Gọi đồ uống theo yêu cầu riêng (sữa yến mạch, thêm shot espresso, ít đường), một phần bánh ngọt và xác nhận phương thức thanh toán.",
                    List.of(
                            "Nêu rõ kích cỡ và nhiệt độ (nóng/đá) của đồ uống mong muốn",
                            "Yêu cầu đổi loại sữa và điều chỉnh độ ngọt phù hợp",
                            "Xác nhận phương thức thanh toán và yêu cầu lấy hóa đơn"
                    ),
                    List.of(
                            "Sử dụng các cách nói tự nhiên như 'Can I get...' hoặc 'I'll have...' khi gọi món.",
                            "Nêu rõ khẩu vị hoặc yêu cầu ăn kiêng (ví dụ: 'with oat milk instead of dairy')."
                    )
            ),
            "Job Interview: Background & Strengths", new LocalizedContent(
                    "Giới thiệu bản thân với người quản lý tuyển dụng tại một công ty công nghệ, tóm tắt kinh nghiệm nổi bật và nêu rõ các thế mạnh chuyên môn cốt lõi.",
                    "Trình bày ngắn gọn kinh nghiệm đã qua, nhấn mạnh các thành tựu nổi bật và giải thích vì sao bạn phù hợp với vị trí.",
                    List.of(
                            "Trình bày phần giới thiệu bản thân ngắn gọn, súc tích trong 2 phút về hành trình sự nghiệp",
                            "Nêu bật số liệu hoặc kết quả đo lường cụ thể từ một dự án trước đây",
                            "Giải thích kỹ năng của bạn giúp giải quyết bài toán của đội ngũ như thế nào"
                    ),
                    List.of(
                            "Cấu trúc thành tích theo mô hình Hành động (Action) và Kết quả (Result).",
                            "Tránh nói chung chung; hãy gắn thế mạnh với công nghệ và kết quả cụ thể."
                    )
            )
    );

    public static LocalizedContent getLocalizedContent(String title) {
        if (title == null) return null;
        for (Map.Entry<String, LocalizedContent> entry : SYSTEM_LOCALIZATIONS.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(title.trim())) {
                return entry.getValue();
            }
        }
        return null;
    }

    public static String getLocalizedDescription(String title, String defaultDesc) {
        LocalizedContent content = getLocalizedContent(title);
        return content != null ? content.description() : defaultDesc;
    }
}
