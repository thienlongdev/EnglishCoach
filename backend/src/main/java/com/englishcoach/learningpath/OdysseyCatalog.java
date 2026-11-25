package com.englishcoach.learningpath;

import com.englishcoach.grammar.GrammarContent;
import org.springframework.stereotype.Component;
import java.util.*;

/** Geography and instructional metadata. Coordinates and discoveries NEVER imply proficiency. */
@Component
public class OdysseyCatalog {
    public static final String VERSION = "odyssey-2026-11-03.1";
    public record Words(String vi, String en) {}
    public record Region(String id, Words name, Words purpose, String skill, String theme, double x, double z,
                         List<String> neighbors, List<String> competencies) {}
    public record Competency(String id, String skill, Words objective, String evidence, String source,
                             List<String> prerequisites, String relation) {}
    private static Words w(String vi, String en) { return new Words(vi, en); }
    public static final List<Region> REGIONS = List.of(
        r("harbor","Cảng Khởi Nguyên","Firstlight Harbor","Bắt đầu từ bằng chứng và nền móng của câu.","Begin with evidence and sentence foundations.","GRAMMAR","harbor",-24,22,"memory,grove,voices","grammar.foundations"),
        r("memory","Vườn Ký Ức","Memory Gardens","Gọi lại từ vựng và ôn đúng lúc.","Retrieve vocabulary and return when review is due.","VOCABULARY","garden",-43,5,"harbor,grove,review","vocabulary.retrieval"),
        r("grove","Rừng Ngôn Từ","Wordroot Grove","Từ loại, cụm danh từ và quy chiếu.","Word classes, noun phrases and reference.","GRAMMAR","garden",-23,0,"harbor,memory,tides,archive","grammar.phrases"),
        r("tides","Tháp Thủy Triều","Tower of Tides","Động từ, thì, thể và tình thái.","Verbs, tense, aspect and modality.","GRAMMAR","tower",-14,-24,"grove,bridges,reef","grammar.time"),
        r("reef","Rạn Thanh Âm","Resonance Reef","Nghe chi tiết, hiểu ý và luyện nghe chủ động.","Listen for detail and meaning through active practice.","LISTENING","reef",8,-16,"tides,voices,trade,trial","listening.detail,listening.discourse"),
        r("voices","Vịnh Tiếng Nói","Bay of Voices","Phát âm dễ hiểu, nói liền mạch và tương tác.","Intelligibility, connected speaking and interaction.","SPEAKING","amphitheatre",0,17,"harbor,reef,communication,lagoon","speaking.production,speaking.interaction"),
        r("archive","Thư Viện Chìm","Sunken Archive","Đọc ý chính, tìm thông tin và hiểu lập luận.","Read for main ideas, information and argument.","READING","archive",-40,-21,"grove,bridges,review","reading.information,reading.argument"),
        r("lagoon","Đầm Ý Tưởng","Inkglass Lagoon","Viết, nhận phản hồi và sửa bài.","Write, receive feedback and revise.","WRITING","archive",20,30,"voices,communication,bridges","writing.purpose,writing.revision"),
        r("bridges","Quần Đảo Liên Kết","Isles of Connection","Ghép mệnh đề, giả định và chuyển lời.","Connect clauses, express hypotheses and report speech.","GRAMMAR","bridge",-5,-43,"tides,archive,aurora,lagoon","grammar.clauses"),
        r("communication","Phố Giao Tiếp","Living Language Port","Dùng ngôn ngữ phù hợp tình huống.","Choose language appropriate to the situation.","SPEAKING","harbor",33,9,"voices,lagoon,trade","communication.pragmatics"),
        r("trade","Thương Cảng TOEIC","TOEIC Trade Winds","Luyện Nghe và Đọc trong bối cảnh công việc.","Practise Listening and Reading in workplace contexts.","ASSESSMENT","harbor",43,-16,"communication,reef,trial","toeic.listening,toeic.reading"),
        r("summit","Thành IELTS","IELTS Citadel","Bốn kỹ năng, dạng bài và tiêu chí đánh giá.","Four skills, task formats and assessment criteria.","ASSESSMENT","citadel",25,-42,"reef,trial,aurora","ielts.four-skills"),
        r("aurora","Đài Cực Quang","Aurora Observatory","Diễn ngôn, sắc thái và khả năng diễn đạt nâng cao.","Discourse, nuance and advanced expression.","GRAMMAR","observatory",-24,-59,"bridges,summit,review","grammar.discourse"),
        r("review","San Hô Hồi Tưởng","Sanctuary of Return","Ôn kiến thức đến hạn; tiến bộ cần được giữ lâu dài.","Review what is due; progress needs lasting retention.","GRAMMAR","reef",-55,-43,"memory,archive,aurora","retention.review"),
        r("trial","Cổng Minh Chứng","Evidence Gateway","Kiểm tra đúng kỹ năng; kết quả luyện tập không phải chứng chỉ.","Assess the intended skill; practice is not certification.","ASSESSMENT","citadel",45,-43,"trade,summit,reef","assessment.integrated")
    );
    private static Region r(String id,String vi,String en,String pvi,String pen,String skill,String theme,double x,double z,String neighbors,String comps) {
        return new Region(id,w(vi,en),w(pvi,pen),skill,theme,x,z,List.of(neighbors.split(",")),List.of(comps.split(",")));
    }
    public static final Map<String,String> DOMAIN_REGION = Map.ofEntries(
        Map.entry("foundations","harbor"), Map.entry("word-classes","grove"), Map.entry("nouns","grove"),
        Map.entry("articles-determiners","grove"), Map.entry("pronouns","grove"), Map.entry("adjectives-adverbs","grove"),
        Map.entry("prepositions","grove"), Map.entry("verbs","tides"), Map.entry("tense-aspect","tides"), Map.entry("modality","tides"),
        Map.entry("questions-negation","bridges"), Map.entry("clauses","bridges"), Map.entry("conditionals","bridges"),
        Map.entry("voice","bridges"), Map.entry("reported-speech","bridges"), Map.entry("nonfinite","bridges"),
        Map.entry("information-structure","aurora"), Map.entry("discourse","aurora"), Map.entry("punctuation","aurora"),
        Map.entry("advanced-usage","aurora"), Map.entry("ielts","summit"), Map.entry("toeic","trade"), Map.entry("communication","communication")
    );
    private final GrammarContent grammar;
    public OdysseyCatalog(GrammarContent grammar) { this.grammar=grammar; }
    public Region region(String id) { return REGIONS.stream().filter(r->r.id().equals(id)).findFirst().orElseThrow(()->new LearningPathException(404,"NOT_FOUND")); }
    public String grammarRegion(String slug) { return DOMAIN_REGION.getOrDefault(grammar.meta(slug).orElseThrow(()->new LearningPathException(404,"NOT_FOUND")).domain(),"harbor"); }
    public String taskRegion(String kind,String goal) { return switch(kind) {
        case "VOCAB_REVIEW"->"memory"; case "DICTATION"->"reef"; case "READING"->"archive";
        case "TOPIC_SPEAKING"->"voices"; case "WRITING"->"lagoon";
        case "EXAM_PRACTICE"->"TOEIC".equals(goal)?"trade":"summit"; default->"trial";
    }; }
    public List<Competency> competencies() { return List.of(
        c("grammar.foundations","GRAMMAR","Nhận diện và tạo câu đơn có nghĩa.","Identify and construct meaningful simple sentences.","TOPIC_CHECK","ACADEMY_EDITORIAL"),
        c("grammar.phrases","GRAMMAR","Chọn từ loại và cụm từ phù hợp.","Choose appropriate word classes and phrases.","TOPIC_CHECK","ACADEMY_EDITORIAL"),
        c("grammar.time","GRAMMAR","Diễn đạt thời gian và thái độ bằng động từ.","Express time and stance through verbs.","TOPIC_CHECK","ACADEMY_EDITORIAL"),
        c("grammar.clauses","GRAMMAR","Liên kết các ý bằng cấu trúc mệnh đề.","Connect ideas using clause structures.","TOPIC_CHECK","ACADEMY_EDITORIAL"),
        c("grammar.discourse","GRAMMAR","Tổ chức thông tin và sắc thái trong văn bản.","Organise information and nuance across texts.","TOPIC_CHECK","ACADEMY_EDITORIAL"),
        c("vocabulary.retrieval","VOCABULARY","Gọi lại nghĩa và cách dùng từ qua ôn tập.","Retrieve word meanings and use through review.","PRACTICE_ONLY","DUNLOSKY_2013"),
        c("listening.detail","LISTENING","Phân biệt lời nói và lấy thông tin cụ thể.","Distinguish speech and retrieve specific information.","SKILL_ASSESSMENT","CEFR_2020"),
        c("listening.discourse","LISTENING","Hiểu ý chính, ý định và diễn ngôn dài.","Understand gist, intention and extended discourse.","SKILL_ASSESSMENT","CEFR_2020"),
        c("reading.information","READING","Tìm thông tin và hiểu ý chính trong văn bản.","Locate information and understand main ideas.","SKILL_ASSESSMENT","CEFR_2020"),
        c("reading.argument","READING","Theo dõi lập luận và suy luận từ văn bản.","Follow arguments and draw inferences from texts.","SKILL_ASSESSMENT","CEFR_2020"),
        c("speaking.production","SPEAKING","Nói dễ hiểu, liền mạch và phù hợp chủ đề.","Speak intelligibly and coherently on a topic.","PERFORMANCE_ASSESSMENT","CEFR_2020"),
        c("speaking.interaction","SPEAKING","Phản hồi và duy trì tương tác nói.","Respond and sustain spoken interaction.","PERFORMANCE_ASSESSMENT","CEFR_2020"),
        c("writing.purpose","WRITING","Viết đúng mục đích với tổ chức và ngôn ngữ phù hợp.","Write for a purpose with suitable organisation and language.","PERFORMANCE_ASSESSMENT","CEFR_2020"),
        c("writing.revision","WRITING","Sửa nội dung và ngôn ngữ dựa trên phản hồi.","Revise content and language using feedback.","PRACTICE_ONLY","CEFR_2020"),
        c("communication.pragmatics","SPEAKING","Điều chỉnh ngôn ngữ theo người nghe và tình huống.","Adapt language to the listener and situation.","PERFORMANCE_ASSESSMENT","CEFR_2020"),
        c("toeic.listening","LISTENING","Luyện bốn phần nghe TOEIC L&R.","Practise the four listening parts of TOEIC L&R.","EXAM_PRACTICE","ETS_TOEIC"),
        c("toeic.reading","READING","Luyện ba phần đọc TOEIC L&R.","Practise the three reading parts of TOEIC L&R.","EXAM_PRACTICE","ETS_TOEIC"),
        c("ielts.four-skills","ASSESSMENT","Chuẩn bị cả Nghe, Đọc, Viết và Nói.","Prepare Listening, Reading, Writing and Speaking.","FOUR_SKILL_ASSESSMENT","IELTS_SCORING"),
        c("retention.review","GRAMMAR","Chứng minh lại kiến thức sau khoảng cách ôn tập.","Demonstrate learning again after a review interval.","REVIEW_CHECK","DUNLOSKY_2013"),
        c("assessment.integrated","ASSESSMENT","Thu thập bằng chứng phù hợp cho từng kỹ năng.","Collect relevant evidence for each skill.","SKILL_ASSESSMENT","CEFR_2020")
    ); }
    private static Competency c(String id,String skill,String vi,String en,String evidence,String source) {
        return new Competency(id,skill,w(vi,en),evidence,source,List.of(),"PARALLEL");
    }
}
