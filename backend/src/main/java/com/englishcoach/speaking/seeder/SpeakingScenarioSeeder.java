package com.englishcoach.speaking.seeder;

import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
@RequiredArgsConstructor
@Slf4j
@ConditionalOnProperty(name = "app.seeding.speaking-scenarios.enabled", havingValue = "true", matchIfMissing = false)
public class SpeakingScenarioSeeder implements CommandLineRunner {

    private final SpeakingScenarioRepository speakingScenarioRepository;

    @Override
    public void run(String... args) {
        if (speakingScenarioRepository.count() == 0) {
            log.info("Seeding structured speaking scenarios for AI Role-play library (app.seeding.speaking-scenarios.enabled=true)...");

            SpeakingScenario hotel = SpeakingScenario.builder()
                    .title("Hotel Check-in & Room Preferences")
                    .description("Làm thủ tục nhận phòng đã đặt trước tại khách sạn Grand Horizon, yêu cầu phòng yên tĩnh ở tầng cao và hỏi về giờ ăn sáng cùng thông tin WiFi.")
                    .cefrLevel(CefrLevel.B1)
                    .category(ScenarioCategory.TRAVEL)
                    .learnerRole("Hotel Guest")
                    .aiRole("Front Desk Receptionist")
                    .learnerGoal("Hoàn tất thủ tục nhận phòng đã đặt, xác nhận thời gian phục vụ bữa sáng và yêu cầu phòng yên tĩnh ở tầng cao.")
                    .targetVocabulary(List.of("reservation", "complimentary", "amenities", "upgrade", "keycard", "checkout"))
                    .targetGrammar(List.of("Could you check if...", "I was wondering if...", "Would it be possible to..."))
                    .initialAiMessage("Good afternoon, welcome to the Grand Horizon Hotel! How may I assist you with your stay today?")
                    .successCriteria(List.of(
                            "Xác nhận thông tin đặt phòng theo tên của bạn",
                            "Đưa ra yêu cầu phòng yên tĩnh hoặc tầng cao một cách lịch sự",
                            "Hỏi về lịch phục vụ bữa sáng và thông tin đăng nhập Wi-Fi"
                    ))
                    .completionConditions("Hoàn tất ít nhất 3 lượt hội thoại và nhận thẻ phòng.")
                    .evaluationRubric("Mức độ hoàn thành mục tiêu (40%), Tính lịch sự và phù hợp ngữ cảnh (30%), Độ chính xác từ vựng (30%)")
                    .optionalHints(List.of(
                            "Sử dụng các câu hỏi gián tiếp lịch sự như 'Could you please tell me...'",
                            "Nếu được đề xuất nâng hạng phòng, hãy hỏi xem có miễn phí không (complimentary)."
                    ))
                    .estimatedMinutes(5)
                    .build();

            SpeakingScenario coffee = SpeakingScenario.builder()
                    .title("Ordering at a Specialty Coffee Shop")
                    .description("Đến quầy gọi đồ tại một quán cà phê phong cách thủ công, gọi đồ uống theo sở thích riêng cùng bánh ngọt và thanh toán bằng thẻ.")
                    .cefrLevel(CefrLevel.A2)
                    .category(ScenarioCategory.DAILY_LIFE)
                    .learnerRole("Customer")
                    .aiRole("Barista")
                    .learnerGoal("Gọi đồ uống theo yêu cầu riêng (sữa yến mạch, thêm shot espresso, ít đường), một phần bánh ngọt và xác nhận phương thức thanh toán.")
                    .targetVocabulary(List.of("espresso", "decaf", "substitute", "pastry", "receipt", "recommendation"))
                    .targetGrammar(List.of("Can I have a...", "I'd like to get...", "Do you take card/cash?"))
                    .initialAiMessage("Hi there! Welcome to Bean & Leaf Coffee. What can I get started for you today?")
                    .successCriteria(List.of(
                            "Nêu rõ kích cỡ và nhiệt độ (nóng/đá) của đồ uống mong muốn",
                            "Yêu cầu đổi loại sữa và điều chỉnh độ ngọt phù hợp",
                            "Xác nhận phương thức thanh toán và yêu cầu lấy hóa đơn"
                    ))
                    .completionConditions("Đặt trọn vẹn món đồ và xác nhận thông tin thanh toán.")
                    .evaluationRubric("Độ rõ ràng của yêu cầu (50%), Từ vựng gọi món hàng ngày (30%), Phát âm (20%)")
                    .optionalHints(List.of(
                            "Sử dụng các cách nói tự nhiên như 'Can I get...' hoặc 'I'll have...' khi gọi món.",
                            "Nêu rõ khẩu vị hoặc yêu cầu ăn kiêng (ví dụ: 'with oat milk instead of dairy')."
                    ))
                    .estimatedMinutes(4)
                    .build();

            SpeakingScenario interview = SpeakingScenario.builder()
                    .title("Job Interview: Background & Strengths")
                    .description("Giới thiệu bản thân với người quản lý tuyển dụng tại một công ty công nghệ, tóm tắt kinh nghiệm nổi bật và nêu rõ các thế mạnh chuyên môn cốt lõi.")
                    .cefrLevel(CefrLevel.B2)
                    .category(ScenarioCategory.BUSINESS)
                    .learnerRole("Job Candidate")
                    .aiRole("Senior Hiring Manager")
                    .learnerGoal("Trình bày ngắn gọn kinh nghiệm đã qua, nhấn mạnh các thành tựu nổi bật và giải thích vì sao bạn phù hợp với vị trí.")
                    .targetVocabulary(List.of("collaborate", "deliverable", "architecture", "cross-functional", "scalable", "initiative"))
                    .targetGrammar(List.of("Over the past few years, I have...", "My primary responsibility was to...", "I specialize in..."))
                    .initialAiMessage("Thank you for joining us today! Let's start by having you walk me through your background and key achievements.")
                    .successCriteria(List.of(
                            "Trình bày phần giới thiệu bản thân ngắn gọn, súc tích trong 2 phút về hành trình sự nghiệp",
                            "Nêu bật số liệu hoặc kết quả đo lường cụ thể từ một dự án trước đây",
                            "Giải thích kỹ năng của bạn giúp giải quyết bài toán của đội ngũ như thế nào"
                    ))
                    .completionConditions("Phản hồi phần chào đầu giới thiệu bản thân và trả lời các câu hỏi kỹ thuật tiếp nối.")
                    .evaluationRubric("Độ trôi chảy chuyên nghiệp (40%), Cấu trúc truyền tải theo STAR (30%), Từ vựng công việc (30%)")
                    .optionalHints(List.of(
                            "Cấu trúc thành tích theo mô hình Hành động (Action) và Kết quả (Result).",
                            "Tránh nói chung chung; hãy gắn thế mạnh với công nghệ và kết quả cụ thể."
                    ))
                    .estimatedMinutes(7)
                    .build();

            SpeakingScenario customs = SpeakingScenario.builder()
                    .title("Airport Immigration & Customs Declaration")
                    .description("Thực hiện thủ tục nhập cảnh khi hạ cánh tại sân bay quốc tế, trả lời các câu hỏi về mục đích chuyến đi và thời gian lưu trú.")
                    .cefrLevel(CefrLevel.B1)
                    .category(ScenarioCategory.TRAVEL)
                    .learnerRole("International Traveler")
                    .aiRole("Border Control Officer")
                    .learnerGoal("Nêu rõ mục đích và thời gian chuyến đi, cung cấp thông tin nơi lưu trú và khai báo hành lý cá nhân.")
                    .targetVocabulary(List.of("customs", "declaration", "itinerary", "sightseeing", "duration", "luggage"))
                    .targetGrammar(List.of("I will be staying for...", "The purpose of my trip is...", "I have nothing to declare except..."))
                    .initialAiMessage("Passport and arrival card, please. What is the purpose of your visit to the United Kingdom?")
                    .successCriteria(List.of(
                            "Nêu rõ mục đích cụ thể (du lịch/công tác/du học) một cách tự tin, rõ ràng",
                            "Xác định rõ thời gian lưu trú và ngày bay về",
                            "Cung cấp rõ tên khách sạn hoặc địa chỉ nơi lưu trú"
                    ))
                    .completionConditions("Trả lời thành công các câu hỏi kiểm tra nhập cảnh để nhận dấu thông quan.")
                    .evaluationRubric("Độ chính xác thông tin (40%), Trả lời trực diện (30%), Phong thái tự tin điềm tĩnh (30%)")
                    .optionalHints(List.of(
                            "Trả lời ngắn gọn, trực diện và đúng trọng tâm, tránh giải thích dài dòng không cần thiết.",
                            "Sử dụng các mẫu câu như 'I'm here for tourism for two weeks'."
                    ))
                    .estimatedMinutes(5)
                    .build();

            speakingScenarioRepository.saveAll(List.of(hotel, coffee, interview, customs));
            log.info("Successfully seeded 4 speaking scenarios with full instructional contracts.");
        }
    }
}
