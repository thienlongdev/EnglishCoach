package com.englishcoach.content.service;

import com.englishcoach.content.config.RssProperties;
import com.englishcoach.content.dto.NormalizedArticleItem;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RssFeedParserTest {

    private RssFeedParser parser;
    private Clock fixedClock;

    @BeforeEach
    void setUp() {
        // Fix clock at 2026-09-30T10:00:00Z
        fixedClock = Clock.fixed(Instant.parse("2026-09-30T10:00:00Z"), ZoneId.of("Asia/Ho_Chi_Minh"));
        parser = new RssFeedParser(fixedClock);
    }

    private RssProperties.RssSourceConfig createMockSource(String key, String name, String category, String level, int readMin, String policy) {
        RssProperties.RssSourceConfig source = new RssProperties.RssSourceConfig();
        source.setKey(key);
        source.setName(name);
        source.setCategory(category);
        source.setDefaultLevel(level);
        source.setTypicalReadMinutes(readMin);
        source.setContentPolicy(policy);
        return source;
    }

    private String loadResource(String path) throws Exception {
        try (InputStream is = getClass().getResourceAsStream(path)) {
            if (is == null) {
                throw new IllegalArgumentException("Resource not found: " + path);
            }
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    @DisplayName("Parse BBC sample: extracts title, clean description, normalized link, media:thumbnail, category")
    void testParseBbcSample() throws Exception {
        String xml = loadResource("/rss/bbc_sample.xml");
        RssProperties.RssSourceConfig source = createMockSource("bbc-world", "BBC", "World", "B2", 4, "SUMMARY_ONLY");

        List<NormalizedArticleItem> items = parser.parse(xml, source);

        assertThat(items).hasSize(2);

        NormalizedArticleItem item1 = items.get(0);
        assertThat(item1.getTitle()).isEqualTo("Global Climate Accord Reached in Geneva");
        // Link should drop tracking query params and fragments
        assertThat(item1.getUrl()).isEqualTo("https://www.bbc.co.uk/news/world-12345");
        // HTML <b> should be stripped
        assertThat(item1.getSummary()).contains("Delegates from over 150 nations agreed");
        assertThat(item1.getSummary()).doesNotContain("<b>");
        assertThat(item1.getThumbnail()).isEqualTo("https://ichef.bbci.co.uk/news/1024/branded_news/climate.jpg");
        assertThat(item1.getCategory()).isEqualTo("Environment");
        assertThat(item1.getLevel()).isEqualTo("B2");
        assertThat(item1.getReadMinutes()).isEqualTo(4);

        NormalizedArticleItem item2 = items.get(1);
        assertThat(item2.getTitle()).isEqualTo("Antarctic Ice Shelf Study Unveils New Data");
        assertThat(item2.getUrl()).isEqualTo("https://www.bbc.co.uk/news/science-67890");
    }

    @Test
    @DisplayName("Parse Guardian sample: media:content image, content:encoded full text when policy is FULL_TEXT")
    void testParseGuardianSample() throws Exception {
        String xml = loadResource("/rss/guardian_sample.xml");
        RssProperties.RssSourceConfig source = createMockSource("guardian-world", "The Guardian", "World", "C1", 5, "FULL_TEXT");

        List<NormalizedArticleItem> items = parser.parse(xml, source);

        assertThat(items).hasSize(1);
        NormalizedArticleItem item = items.get(0);
        assertThat(item.getTitle()).isEqualTo("Sustainable Urban Transport Initiatives Expand in Europe");
        assertThat(item.getUrl()).isEqualTo("https://www.theguardian.com/world/2026/sep/21/urban-transport");
        assertThat(item.getThumbnail()).isEqualTo("https://media.guim.co.uk/sample-transit.jpg");
        assertThat(item.getReadingContent()).isNotNull();
        assertThat(item.getReadingContent()).contains("Metropolitan authorities across northern Europe");
        assertThat(item.getReadingContent()).doesNotContain("<p>");
    }

    @Test
    @DisplayName("Parse VOA sample: enclosure image and default summary policy")
    void testParseVoaSample() throws Exception {
        String xml = loadResource("/rss/voa_sample.xml");
        RssProperties.RssSourceConfig source = createMockSource("voa-learning-english", "VOA", "Learning English", "B1", 3, "SUMMARY_ONLY");

        List<NormalizedArticleItem> items = parser.parse(xml, source);

        assertThat(items).hasSize(1);
        NormalizedArticleItem item = items.get(0);
        assertThat(item.getTitle()).isEqualTo("Volunteers Restore Ancient Woodland Corridors");
        assertThat(item.getThumbnail()).isEqualTo("https://learningenglish.voanews.com/images/woodland.jpg");
        assertThat(item.getReadingContent()).isNull();
    }

    @Test
    @DisplayName("XXE Protection: DOCTYPE declaration is disallowed and throws exception")
    void testXxeProtection() throws Exception {
        String xxeXml = loadResource("/rss/xxe_payload.xml");
        RssProperties.RssSourceConfig source = createMockSource("test-xxe", "XXE Test", "Test", "B2", 3, "SUMMARY_ONLY");

        assertThatThrownBy(() -> parser.parse(xxeXml, source))
                .isInstanceOf(Exception.class);
    }

    @Test
    @DisplayName("Malformed XML is handled safely by throwing handled exception")
    void testMalformedXml() throws Exception {
        String malformed = loadResource("/rss/malformed.xml");
        RssProperties.RssSourceConfig source = createMockSource("test-malformed", "Malformed", "Test", "B2", 3, "SUMMARY_ONLY");

        assertThatThrownBy(() -> parser.parse(malformed, source))
                .isInstanceOf(Exception.class);
    }

    @Test
    @DisplayName("pubDate parsing fallback and future date clamp")
    void testPubDateClamping() throws Exception {
        String futureXml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <rss version="2.0">
                  <channel>
                    <title>Future News</title>
                    <item>
                      <title>Future Article</title>
                      <link>https://example.com/future</link>
                      <description>Future news item.</description>
                      <pubDate>Thu, 15 Oct 2026 12:00:00 GMT</pubDate>
                    </item>
                  </channel>
                </rss>
                """;
        RssProperties.RssSourceConfig source = createMockSource("future", "Future", "News", "B1", 3, "SUMMARY_ONLY");

        List<NormalizedArticleItem> items = parser.parse(futureXml, source);
        assertThat(items).hasSize(1);
        assertThat(items.get(0).getPublishedAt()).isEqualTo(Instant.parse("2026-09-30T10:00:00Z"));
    }

    @Test
    @DisplayName("Reject non-http / non-https links")
    void testRejectNonHttpLinks() throws Exception {
        String nonHttpXml = """
                <?xml version="1.0" encoding="UTF-8"?>
                <rss version="2.0">
                  <channel>
                    <title>Invalid Links</title>
                    <item>
                      <title>Bad Link Article</title>
                      <link>javascript:alert(1)</link>
                      <description>Description</description>
                    </item>
                    <item>
                      <title>File Link Article</title>
                      <link>file:///etc/hosts</link>
                      <description>Description</description>
                    </item>
                  </channel>
                </rss>
                """;
        RssProperties.RssSourceConfig source = createMockSource("bad-link", "Bad", "News", "B1", 3, "SUMMARY_ONLY");

        List<NormalizedArticleItem> items = parser.parse(nonHttpXml, source);
        assertThat(items).isEmpty();
    }
}
