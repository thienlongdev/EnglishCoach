"""Offline Genre and Topic Classification for Paragraphs.

Applies deterministic keyword/lexical density taxonomy to classify genre and topic independently.
Does NOT force fake academic or dialogue labels onto general Wikipedia prose.
If confidence is insufficient, UNKNOWN or GENERAL is assigned.
"""

import re
from typing import Tuple, List, Dict
from .contracts import Genre, Topic, ClassificationResult, PassageCandidate


# Topic vocabulary matching existing Translation topics
TOPIC_KEYWORDS: Dict[Topic, List[str]] = {
    Topic.EDUCATION: [
        "university", "school", "student", "faculty", "degree", "academic", "college",
        "campus", "education", "professor", "curriculum", "scholar", "institute", "tuition",
        "pedagogy", "textbook", "classroom", "alumni", "undergraduate", "postgraduate", "phd",
        "đại học", "trường học", "sinh viên", "học sinh", "giảng viên", "học thuật", "giáo dục",
        "học viện", "học vị", "bằng cấp", "học phần", "chương trình học", "giáo sư", "tiến sĩ", "thạc sĩ"
    ],
    Topic.TECHNOLOGY: [
        "computer", "software", "hardware", "internet", "algorithm", "digital", "network",
        "programming", "system", "data", "database", "technology", "artificial intelligence",
        "machine learning", "neural network", "cybersecurity", "processor", "server", "telecommunication",
        "robotics", "encryption", "source code", "operating system", "computing",
        "máy tính", "phần mềm", "phần cứng", "công nghệ", "mạng", "thuật toán", "dữ liệu",
        "kỹ thuật số", "trí tuệ nhân tạo", "học máy", "mạng nơ-ron", "an ninh mạng", "máy chủ",
        "viễn thông", "robot", "mã hóa", "mã nguồn", "hệ điều hành", "lập trình"
    ],
    Topic.HEALTH: [
        "health", "medicine", "medical", "disease", "patient", "doctor", "hospital",
        "virus", "treatment", "therapy", "clinical", "symptom", "vaccine", "surgery",
        "infection", "illness", "physician", "pharmaceutical", "disorder", "diagnosis", "pathology",
        "sức khỏe", "y tế", "y khoa", "bệnh", "bệnh nhân", "bác sĩ", "bệnh viện", "điều trị",
        "thuốc", "nhiễm trùng", "liệu pháp", "triệu chứng", "vắc-xin", "phẫu thuật", "chẩn đoán", "dược phẩm"
    ],
    Topic.ENVIRONMENT: [
        "environment", "climate", "nature", "species", "forest", "wildlife", "ocean",
        "pollution", "ecology", "ecosystem", "conservation", "planet", "carbon",
        "biodiversity", "habitat", "global warming", "renewable energy", "emission", "deforestation",
        "môi trường", "khí hậu", "thiên nhiên", "loài", "rừng", "hệ sinh thái", "bảo tồn",
        "đại dương", "ô nhiễm", "sinh thái", "hành tinh", "các-bon", "đa dạng sinh học", "nóng lên toàn cầu"
    ],
    Topic.TRAVEL: [
        "travel", "tourism", "tourist", "destination", "hotel", "flight", "journey",
        "island", "resort", "attraction", "visitor", "explore", "vacation", "airline",
        "sightseeing", "itinerary", "backpacking", "voyage",
        "du lịch", "khách du lịch", "điểm đến", "khách sạn", "chuyến đi", "đảo",
        "khu nghỉ dưỡng", "kỳ nghỉ", "tham quan", "hành trình", "thắng cảnh", "vé máy bay"
    ],
    Topic.CULTURE: [
        "culture", "art", "music", "history", "film", "movie", "theatre", "tradition",
        "heritage", "painting", "museum", "festival", "literature", "sculpture", "folklore",
        "cinema", "poetry", "orchestra", "monument", "exhibition", "customs",
        "văn hóa", "nghệ thuật", "âm nhạc", "lịch sử", "phim", "truyền thống", "bảo tàng",
        "điện ảnh", "sân khấu", "di sản", "hội họa", "lễ hội", "văn học", "điêu khắc", "thơ ca"
    ],
    Topic.SOCIETY: [
        "society", "government", "policy", "law", "rights", "community", "social",
        "citizen", "election", "economy", "public", "organization", "international",
        "politics", "legislation", "democracy", "parliament", "treaty", "welfare", "civil",
        "xã hội", "chính phủ", "chính sách", "pháp luật", "cộng đồng", "công dân", "kinh tế",
        "công cộng", "chính trị", "dân chủ", "quốc hội", "hiệp ước", "phúc lợi", "dân sự"
    ],
    Topic.WORK: [
        "career", "business", "company", "industry", "employment", "workplace",
        "worker", "employee", "management", "profession", "corporate", "recruitment",
        "salary", "wage", "enterprise", "entrepreneur", "corporation",
        "nghề nghiệp", "kinh doanh", "công ty", "ngành công nghiệp", "việc làm",
        "tuyển dụng", "nhân viên", "người lao động", "quản lý", "doanh nghiệp", "doanh nhân", "tiền lương"
    ],
    Topic.FAMILY: [
        "family", "parent", "child", "children", "mother", "father", "marriage",
        "household", "generation", "relative", "sibling", "parenting", "spouse", "ancestor",
        "gia đình", "cha mẹ", "con cái", "mẹ", "cha", "kết hôn", "hôn nhân",
        "hộ gia đình", "thế hệ", "họ hàng", "anh chị em", "vợ chồng", "tổ tiên"
    ],
    Topic.URBAN_LIFE: [
        "city", "urban", "street", "building", "neighborhood", "metro", "subway",
        "traffic", "infrastructure", "town", "municipality", "skyscraper", "suburb", "downtown",
        "thành phố", "đô thị", "đường phố", "tòa nhà", "khu phố", "hạ tầng",
        "tàu điện ngầm", "giao thông", "tòa nhà chọc trời", "ngoại ô", "trung tâm thành phố"
    ]
}

# Academic markers in English
ACADEMIC_INDICATORS = [
    r'\baccording to\b', r'\bdemonstrates?\b', r'\bevidence\b', r'\bhypothesis\b',
    r'\bmethodology\b', r'\bsignificantly\b', r'\bcorrelated\b', r'\banalysis\b',
    r'\bfindings\b', r'\btheoretical\b', r'\bperspective\b', r'\bconcluded?\b',
    r'\bfaculty\b', r'\bresearchers?\b', r'\bpublished\b', r'\bpeer-reviewed\b'
]


class Classifier:
    """Classifies paragraph candidates into genre and topic offline."""

    @staticmethod
    def classify(candidate: PassageCandidate) -> ClassificationResult:
        # 1. Deterministic weighted evidence topic classification:
        # Title evidence (weight 4.0): document source and target titles
        # Section evidence (weight 2.5): section id and structural context
        # Passage evidence (weight 1.0): English and Vietnamese paragraph text
        title_text = f"{candidate.source_page_title} {candidate.target_page_title}".lower()
        section_text = f"{candidate.section_id} {getattr(candidate, 'section_heading', '')}".lower()
        en = candidate.en_text.lower()
        vi = candidate.vi_text.lower()
        passage_text = f"{en} {vi}"

        topic_scores: Dict[Topic, float] = {}
        topic_kw_counts: Dict[Topic, int] = {}
        topic_title_hits: Dict[Topic, bool] = {}

        for topic, kws in TOPIC_KEYWORDS.items():
            # Count distinct keyword occurrences across components
            title_hits = 0
            section_hits = 0
            passage_hits = 0
            matched_kws = set()

            for kw in kws:
                pattern = r'\b' + re.escape(kw) + r'\b'
                t_hit = bool(re.search(pattern, title_text))
                s_hit = bool(re.search(pattern, section_text))
                p_hit = bool(re.search(pattern, passage_text))

                if t_hit:
                    title_hits += 1
                    matched_kws.add(kw)
                if s_hit:
                    section_hits += 1
                    matched_kws.add(kw)
                if p_hit:
                    passage_hits += 1
                    matched_kws.add(kw)

            weighted_score = (title_hits * 4.0) + (section_hits * 2.5) + (passage_hits * 1.0)
            if weighted_score > 0:
                topic_scores[topic] = weighted_score
                topic_kw_counts[topic] = len(matched_kws)
                topic_title_hits[topic] = (title_hits > 0)

        # Qualification rule:
        # A topic qualifies if:
        # 1. weighted score >= 3.0
        # 2. at least 2 distinct keywords matched OR document title explicitly matched
        # (prevents single accidental keyword like 'work' in a non-work article)
        qualifying_topics = [
            (t, sc) for t, sc in topic_scores.items()
            if sc >= 3.0 and (topic_kw_counts[t] >= 2 or topic_title_hits[t])
        ]

        if qualifying_topics:
            sorted_topics = sorted(qualifying_topics, key=lambda x: x[1], reverse=True)
            top_topic, top_score = sorted_topics[0]

            # Ambiguity check: if top 2 topics are tied or difference is less than 1.0 without title confirmation,
            # fall back to GENERAL rather than guessing incorrectly.
            if len(sorted_topics) > 1:
                runner_up_topic, runner_up_score = sorted_topics[1]
                if abs(top_score - runner_up_score) < 1.0 and not topic_title_hits[top_topic]:
                    primary_topic = Topic.GENERAL
                    confidence = 0.50
                else:
                    primary_topic = top_topic
                    confidence = min(0.95, max(0.60, top_score / 10.0))
            else:
                primary_topic = top_topic
                confidence = min(0.95, max(0.60, top_score / 10.0))

            secondary = [t for t, sc in sorted_topics if t != primary_topic and sc >= 2.0][:2]
        else:
            primary_topic = Topic.GENERAL
            confidence = 0.50
            secondary = []

        # 2. Genre classification
        # For Wikipedia ContentTranslation, prose is expository: predominantly GENERAL.
        # It is classified as ACADEMIC only if strong academic markers / scholarly research context is present.
        academic_matches = sum(1 for p in ACADEMIC_INDICATORS if re.search(p, en))
        if academic_matches >= 3 or (primary_topic == Topic.EDUCATION and academic_matches >= 2):
            primary_genre = Genre.ACADEMIC
            genre_conf = 0.80
        else:
            primary_genre = Genre.GENERAL
            genre_conf = 0.90

        return ClassificationResult(
            primary_genre=primary_genre,
            genre_confidence=genre_conf,
            primary_topic=primary_topic,
            topic_confidence=confidence,
            secondary_topics=secondary
        )
