-- V47__content_hub_platform.sql
-- Content Hub Foundation: Feed Articles, Reading Content, YouTube Feed, Listening Content, Content Vocabulary

-- 1. feed_articles
CREATE TABLE IF NOT EXISTS public.feed_articles (
    id BIGSERIAL PRIMARY KEY,
    source VARCHAR(100) NOT NULL,
    title VARCHAR(500) NOT NULL,
    url VARCHAR(1000) NOT NULL,
    thumbnail VARCHAR(1000) NULL,
    summary TEXT NULL,
    category VARCHAR(100) NULL,
    level VARCHAR(10) NOT NULL DEFAULT 'B1',
    read_minutes INT NOT NULL DEFAULT 3,
    published_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feed_articles_published_at_desc
    ON public.feed_articles (published_at DESC);

-- 2. reading_content
CREATE TABLE IF NOT EXISTS public.reading_content (
    id BIGSERIAL PRIMARY KEY,
    source_article_id BIGINT REFERENCES public.feed_articles(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    word_count INT NOT NULL DEFAULT 0,
    level VARCHAR(10) NOT NULL DEFAULT 'B1',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reading_content_source_article
    ON public.reading_content (source_article_id);

-- 3. youtube_feed
CREATE TABLE IF NOT EXISTS public.youtube_feed (
    id BIGSERIAL PRIMARY KEY,
    video_id VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(500) NOT NULL,
    channel VARCHAR(255) NOT NULL,
    thumbnail VARCHAR(1000) NULL,
    duration VARCHAR(50) NULL,
    published_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. listening_content
CREATE TABLE IF NOT EXISTS public.listening_content (
    id BIGSERIAL PRIMARY KEY,
    kind VARCHAR(20) NOT NULL DEFAULT 'LISTENING',
    youtube_video_id VARCHAR(50) NULL,
    title VARCHAR(500) NOT NULL,
    channel VARCHAR(255) NULL,
    level VARCHAR(10) NOT NULL DEFAULT 'B1',
    duration INT NOT NULL DEFAULT 0,
    audio_url VARCHAR(1000) NULL,
    thumbnail VARCHAR(1000) NULL,
    transcript TEXT NULL,
    transcript_hidden BOOLEAN NOT NULL DEFAULT FALSE,
    accent VARCHAR(50) NULL,
    topic VARCHAR(100) NULL,
    featured_on DATE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listening_content_kind_featured_on
    ON public.listening_content (kind, featured_on DESC);

-- 5. content_vocabulary
CREATE TABLE IF NOT EXISTS public.content_vocabulary (
    id BIGSERIAL PRIMARY KEY,
    content_type VARCHAR(50) NOT NULL,
    content_id BIGINT NOT NULL,
    word VARCHAR(100) NOT NULL,
    lemma VARCHAR(100) NULL,
    phonetic VARCHAR(100) NULL,
    meaning VARCHAR(500) NOT NULL,
    example_sentence TEXT NULL,
    frequency INT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_content_vocabulary_type_id
    ON public.content_vocabulary (content_type, content_id);

-- ============================================================================
-- SEED DATA (Idempotent: guarded by NOT EXISTS)
-- ============================================================================

-- Article 1: BBC | B2 | Work | "Why more people are choosing four-day work weeks"
INSERT INTO public.feed_articles (source, title, url, thumbnail, summary, category, level, read_minutes, published_at)
SELECT 'BBC',
       'Why more people are choosing four-day work weeks',
       'https://www.bbc.com',
       NULL,
       'Companies worldwide are experimenting with condensed working schedules to boost employee well-being without reducing salaries. Initial findings suggest that shorter work weeks reduce stress and enhance productivity across various industries.',
       'Work',
       'B2',
       4,
       NOW() - INTERVAL '1 day'
WHERE NOT EXISTS (
    SELECT 1 FROM public.feed_articles WHERE title = 'Why more people are choosing four-day work weeks'
);

-- Article 1 reading_content
INSERT INTO public.reading_content (source_article_id, title, content, word_count, level)
SELECT fa.id,
       'Why more people are choosing four-day work weeks',
       'The concept of the four-day work week has moved from an idealistic dream into corporate reality. Over the past three years, extensive trials conducted in the United Kingdom, Iceland, and New Zealand have demonstrated encouraging outcomes for both employers and their workforce. Under the standard model, employees receive one hundred percent of their regular pay while committing to eighty percent of their usual working hours, provided that overall productivity remains unchanged. Managers report that reduced weekly hours force teams to streamline communication, eliminate unnecessary status meetings, and focus intensely on high-priority objectives. From the perspective of workers, the additional day off substantially alleviates chronic fatigue and personal stress. Staff members use their extra leisure time to pursue personal development, attend medical appointments, and spend quality moments with family. As work-life balance improves, companies report significant reductions in voluntary turnover and employee burnout. Although certain sectors like emergency healthcare and continuous manufacturing face operational hurdles, the four-day schedule continues to gain serious momentum in modern white-collar environments.',
       167,
       'B2'
FROM public.feed_articles fa
WHERE fa.title = 'Why more people are choosing four-day work weeks'
  AND NOT EXISTS (
      SELECT 1 FROM public.reading_content rc WHERE rc.source_article_id = fa.id
  );

-- Article 1 vocabulary
INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'productivity', 'productivity', '/ˌprɒd.ʌkˈtɪv.ə.ti/', 'Năng suất làm việc', 'Reduced hours force teams to focus on productivity and eliminate unnecessary meetings.', 15
FROM public.feed_articles fa
WHERE fa.title = 'Why more people are choosing four-day work weeks'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'productivity');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'fatigue', 'fatigue', '/fəˈtiːɡ/', 'Tình trạng mệt mỏi suy nhược', 'The extra day off substantially alleviates chronic fatigue and stress.', 12
FROM public.feed_articles fa
WHERE fa.title = 'Why more people are choosing four-day work weeks'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'fatigue');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'turnover', 'turnover', '/ˈtɜːnˌəʊ.vər/', 'Tỷ lệ nhân viên nghỉ việc hoặc thay thế', 'Companies report significant reductions in voluntary employee turnover.', 10
FROM public.feed_articles fa
WHERE fa.title = 'Why more people are choosing four-day work weeks'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'turnover');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'streamline', 'streamline', '/ˈstriːm.laɪn/', 'Tối giản hóa, tinh gọn quy trình', 'Managers must streamline communication to keep projects on track.', 8
FROM public.feed_articles fa
WHERE fa.title = 'Why more people are choosing four-day work weeks'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'streamline');


-- Article 2: The Guardian | B2 | Environment | "Cities try quieter streets to cut noise pollution"
INSERT INTO public.feed_articles (source, title, url, thumbnail, summary, category, level, read_minutes, published_at)
SELECT 'The Guardian',
       'Cities try quieter streets to cut noise pollution',
       'https://www.theguardian.com',
       NULL,
       'Urban planners across European capitals are introducing acoustic barriers and low-speed zones to counter harmful sound levels. Medical researchers emphasize that persistent traffic noise represents an invisible threat to long-term cardiovascular health.',
       'Environment',
       'B2',
       4,
       NOW() - INTERVAL '2 days'
WHERE NOT EXISTS (
    SELECT 1 FROM public.feed_articles WHERE title = 'Cities try quieter streets to cut noise pollution'
);

-- Article 2 reading_content
INSERT INTO public.reading_content (source_article_id, title, content, word_count, level)
SELECT fa.id,
       'Cities try quieter streets to cut noise pollution',
       'Metropolitan centers are awakening to the serious dangers posed by persistent urban acoustics. For decades, urban planning prioritized vehicular velocity over acoustic comfort, leaving residents vulnerable to elevated decibel levels day and night. Recent epidemiological investigations reveal that chronic exposure to traffic rumble contributes directly to heightened cortisol levels, sleep fragmentation, and long-term cardiovascular complications. To reclaim sonic serenity, municipal authorities in Paris, Amsterdam, and Zurich are taking aggressive measures. Low-emission zones now enforce strict speed ceilings of thirty kilometers per hour, which dramatically dampens tire noise and engine roar. In addition, civil engineers are installing acoustic asphalt that absorbs sound frequencies rather than reflecting them against concrete buildings. Pedestrian zones and pocket parks are also proliferating near residential sectors, providing natural buffers rich in green foliage. Public feedback has been overwhelmingly positive, with local merchants reporting increased foot traffic and livelier neighborhood interaction. By treating urban silence as a public health priority, cities are redefining modern urban livability.',
       160,
       'B2'
FROM public.feed_articles fa
WHERE fa.title = 'Cities try quieter streets to cut noise pollution'
  AND NOT EXISTS (
      SELECT 1 FROM public.reading_content rc WHERE rc.source_article_id = fa.id
  );

-- Article 2 vocabulary
INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'acoustic', 'acoustic', '/əˈkuː.stɪk/', 'Thuộc về âm thanh, âm học', 'Engineers are installing acoustic asphalt to absorb sound frequencies.', 14
FROM public.feed_articles fa
WHERE fa.title = 'Cities try quieter streets to cut noise pollution'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'acoustic');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'cardiovascular', 'cardiovascular', '/ˌkɑː.di.əʊˈvæs.kjə.lər/', 'Thuộc về tim mạch', 'Traffic rumble contributes to long-term cardiovascular complications.', 11
FROM public.feed_articles fa
WHERE fa.title = 'Cities try quieter streets to cut noise pollution'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'cardiovascular');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'serenity', 'serenity', '/səˈren.ə.ti/', 'Sự thanh bình, tĩnh lặng', 'Residents appreciate the return of sonic serenity to their neighborhood.', 9
FROM public.feed_articles fa
WHERE fa.title = 'Cities try quieter streets to cut noise pollution'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'serenity');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'pedestrian', 'pedestrian', '/pəˈdes.tri.ən/', 'Dành cho người đi bộ, người đi bộ', 'Pedestrian zones provide natural buffers and encourage local foot traffic.', 8
FROM public.feed_articles fa
WHERE fa.title = 'Cities try quieter streets to cut noise pollution'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'pedestrian');


-- Article 3: VOA | B1 | Education | "Students use digital tools to plan their study time"
INSERT INTO public.feed_articles (source, title, url, thumbnail, summary, category, level, read_minutes, published_at)
SELECT 'VOA',
       'Students use digital tools to plan their study time',
       'https://www.voanews.com',
       NULL,
       'Young learners are adopting interactive scheduling applications to organize assignments and balance revision sessions. Educators note that structured digital habits help prevent procrastination and build independent learning confidence.',
       'Education',
       'B1',
       3,
       NOW() - INTERVAL '3 days'
WHERE NOT EXISTS (
    SELECT 1 FROM public.feed_articles WHERE title = 'Students use digital tools to plan their study time'
);

-- Article 3 reading_content
INSERT INTO public.reading_content (source_article_id, title, content, word_count, level)
SELECT fa.id,
       'Students use digital tools to plan their study time',
       'Modern students face countless distractions from smartphones, online gaming, and social networks. Managing school assignments and exam preparation can quickly become overwhelming without clear daily organization. In response, an increasing number of high school and university learners are turning to digital task managers and calendar tools. These simple applications allow students to break major revision targets into realistic daily milestones. Instead of cramming notes the night before an important test, learners distribute their review periods across several weeks. Many tools include visual timers based on the Pomodoro technique, prompting regular short breaks to maintain high concentration. Teachers observe noticeable progress in students who adopt structured planning methods. Class participants submit assignments on time more consistently and express less anxiety during exam seasons. Furthermore, learning how to prioritize daily tasks prepares young individuals for university independence and future professional obligations. With appropriate digital discipline, technology becomes a valuable companion rather than an endless distraction.',
       154,
       'B1'
FROM public.feed_articles fa
WHERE fa.title = 'Students use digital tools to plan their study time'
  AND NOT EXISTS (
      SELECT 1 FROM public.reading_content rc WHERE rc.source_article_id = fa.id
  );

-- Article 3 vocabulary
INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'procrastination', 'procrastinate', '/prəˌkræs.tɪˈneɪ.ʃən/', 'Sự chần chừ, trì hoãn công việc', 'Structured habits help prevent procrastination during exam preparation.', 13
FROM public.feed_articles fa
WHERE fa.title = 'Students use digital tools to plan their study time'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'procrastination');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'distraction', 'distraction', '/dɪˈstræk.ʃən/', 'Sự xao nhãng, yếu tố làm mất tập trung', 'Smartphones can become a major distraction if notifications remain active.', 11
FROM public.feed_articles fa
WHERE fa.title = 'Students use digital tools to plan their study time'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'distraction');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'milestone', 'milestone', '/ˈmaɪl.stəʊn/', 'Cột mốc quan trọng, mục tiêu từng chặng', 'Break major revision targets into realistic daily milestones.', 9
FROM public.feed_articles fa
WHERE fa.title = 'Students use digital tools to plan their study time'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'milestone');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'prioritize', 'prioritize', '/praɪˈɒr.ɪ.taɪz/', 'Ưu tiên, sắp xếp theo thứ tự quan trọng', 'Learning how to prioritize tasks prepares students for adult life.', 8
FROM public.feed_articles fa
WHERE fa.title = 'Students use digital tools to plan their study time'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'prioritize');


-- Article 4: The Economist | C1 | Business | "Why cheap flights are getting less cheap"
INSERT INTO public.feed_articles (source, title, url, thumbnail, summary, category, level, read_minutes, published_at)
SELECT 'The Economist',
       'Why cheap flights are getting less cheap',
       'https://www.economist.com',
       NULL,
       'Surging fuel costs, supply chain bottlenecks for aircraft parts, and tighter carbon emission mandates are squeezing budget airlines. Industry analysts predict the era of ultra-low baseline airfares is coming to a permanent close.',
       'Business',
       'C1',
       5,
       NOW() - INTERVAL '4 days'
WHERE NOT EXISTS (
    SELECT 1 FROM public.feed_articles WHERE title = 'Why cheap flights are getting less cheap'
);

-- Article 4 reading_content
INSERT INTO public.reading_content (source_article_id, title, content, word_count, level)
SELECT fa.id,
       'Why cheap flights are getting less cheap',
       'For nearly three decades, budget aviation revolutionized commercial travel across the globe. Low-cost carriers relentlessly unbundled amenities, perfected rapid turnaround times at secondary airports, and stimulated consumer demand with nominal headline fares. Yet the economic scaffolding that underpinned hyper-cheap air travel is now rapidly disintegrating under compounding structural pressures. Foremost among these headwinds is the acute scarcity of commercial aircraft and replacement components. Both major aerospace manufacturers have suffered protracted delivery delays, forcing airlines to lease aging planes at exorbitant rates or curtail lucrative route frequencies. Concurrently, aviation jet fuel expenditures remain stubbornly elevated, aggravated by persistent geopolitical friction in vital maritime transit corridors. Environmental legislation adds further upward pressure onto operational ledgers. Stringent decarbonization directives, such as mandatory blending quotas for sustainable aviation fuels and dwindling free carbon allowances, cannot be absorbed by paper-thin operating margins. Inevitably, carriers are passing these structural outlays onto travelers. While demand for leisure voyage persists, the era of discretionary bargain fares has effectively drawn to a close.',
       164,
       'C1'
FROM public.feed_articles fa
WHERE fa.title = 'Why cheap flights are getting less cheap'
  AND NOT EXISTS (
      SELECT 1 FROM public.reading_content rc WHERE rc.source_article_id = fa.id
  );

-- Article 4 vocabulary
INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'aviation', 'aviation', '/ˌeɪ.viˈeɪ.ʃən/', 'Ngành hàng không', 'Budget aviation revolutionized commercial travel over the past three decades.', 15
FROM public.feed_articles fa
WHERE fa.title = 'Why cheap flights are getting less cheap'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'aviation');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'exorbitant', 'exorbitant', '/ɪɡˈzɔː.bɪ.tənt/', 'Cắt cổ, quá cao (về giá cả, chi phí)', 'Airlines must lease aging planes at exorbitant rates due to delivery delays.', 12
FROM public.feed_articles fa
WHERE fa.title = 'Why cheap flights are getting less cheap'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'exorbitant');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'decarbonization', 'decarbonization', '/diːˌkɑː.bən.aɪˈzeɪ.ʃən/', 'Quá trình giảm thải carbon', 'Stringent decarbonization directives impose significant operational costs.', 10
FROM public.feed_articles fa
WHERE fa.title = 'Why cheap flights are getting less cheap'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'decarbonization');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'ARTICLE', fa.id, 'curtail', 'curtail', '/kəˈteɪl/', 'Cắt giảm, hạn chế', 'Carriers were forced to curtail lucrative route frequencies this summer.', 8
FROM public.feed_articles fa
WHERE fa.title = 'Why cheap flights are getting less cheap'
  AND NOT EXISTS (SELECT 1 FROM public.content_vocabulary cv WHERE cv.content_type = 'ARTICLE' AND cv.content_id = fa.id AND cv.word = 'curtail');


-- ============================================================================
-- LISTENING & DICTATION TODAY SEED DATA
-- ============================================================================

-- 1 Listening Today: kind 'LISTENING', title 'How Sleep Shapes Memory'
INSERT INTO public.listening_content (
    kind, youtube_video_id, title, channel, level, duration, audio_url, thumbnail, transcript, transcript_hidden, accent, topic, featured_on
)
SELECT 'LISTENING',
       NULL,
       'How Sleep Shapes Memory',
       'English Coach Podcast',
       'B2',
       480,
       NULL,
       NULL,
       NULL,
       FALSE,
       'British',
       'Health & Science',
       CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_content WHERE title = 'How Sleep Shapes Memory' AND kind = 'LISTENING'
);

-- 1 Daily Dictation: kind 'DICTATION', title 'Ordering Coffee'
INSERT INTO public.listening_content (
    kind, youtube_video_id, title, channel, level, duration, audio_url, thumbnail, transcript, transcript_hidden, accent, topic, featured_on
)
SELECT 'DICTATION',
       NULL,
       'Ordering Coffee',
       NULL,
       'B1',
       20,
       NULL,
       NULL,
       'Good morning! I''d like a medium latte with oat milk, please. Could you make it extra hot? Oh, and I''ll have one blueberry muffin as well. I''m paying by card, and I don''t need a receipt. Thank you very much, have a great day!',
       TRUE,
       'American',
       'Daily Life',
       CURRENT_DATE
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_content WHERE title = 'Ordering Coffee' AND kind = 'DICTATION'
);


-- ============================================================================
-- 5 TRENDING VOCABULARY SEED DATA
-- ============================================================================

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'TRENDING', 0, 'doomscrolling', 'doomscroll', '/ˈduːmˌskroʊlɪŋ/', 'lướt tin tiêu cực liên tục không dừng được', 'I lost an hour of sleep doomscrolling through bad news last night.', 50
WHERE NOT EXISTS (SELECT 1 FROM public.content_vocabulary WHERE content_type = 'TRENDING' AND word = 'doomscrolling');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'TRENDING', 0, 'burnout', 'burnout', '/ˈbɝːnaʊt/', 'kiệt sức vì làm việc/học tập kéo dài', 'After months of overtime, she took a break to avoid burnout.', 40
WHERE NOT EXISTS (SELECT 1 FROM public.content_vocabulary WHERE content_type = 'TRENDING' AND word = 'burnout');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'TRENDING', 0, 'side hustle', 'side hustle', '/ˈsaɪd ˌhʌsəl/', 'công việc tay trái, nguồn thu nhập phụ', 'He runs a small online shop as a side hustle.', 30
WHERE NOT EXISTS (SELECT 1 FROM public.content_vocabulary WHERE content_type = 'TRENDING' AND word = 'side hustle');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'TRENDING', 0, 'ghosting', 'ghost', '/ˈɡoʊstɪŋ/', 'đột ngột cắt liên lạc, im lặng không giải thích', 'She felt hurt when he started ghosting her without any explanation.', 20
WHERE NOT EXISTS (SELECT 1 FROM public.content_vocabulary WHERE content_type = 'TRENDING' AND word = 'ghosting');

INSERT INTO public.content_vocabulary (content_type, content_id, word, lemma, phonetic, meaning, example_sentence, frequency)
SELECT 'TRENDING', 0, 'touch grass', 'touch grass', '/ˌtʌtʃ ˈɡræs/', '(thành ngữ) rời màn hình, ra ngoài tiếp xúc đời thực', 'You''ve been arguing online all day - go touch grass.', 10
WHERE NOT EXISTS (SELECT 1 FROM public.content_vocabulary WHERE content_type = 'TRENDING' AND word = 'touch grass');
