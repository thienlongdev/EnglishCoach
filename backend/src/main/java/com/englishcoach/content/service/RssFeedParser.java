package com.englishcoach.content.service;

import com.englishcoach.content.config.RssProperties.RssSourceConfig;
import com.englishcoach.content.dto.NormalizedArticleItem;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.StringReader;
import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Pure, secure XML parser for RSS 2.0 feeds.
 * Rejects XXE, disallows DOCTYPE declarations, skips Atom feeds with a WARN,
 * and normalizes articles per the Content Hub specification.
 */
@Slf4j
@Component
public class RssFeedParser {

    private static final String MEDIA_NS = "http://search.yahoo.com/mrss/";
    private static final String CONTENT_NS = "http://purl.org/rss/1.0/modules/content/";

    private static final DateTimeFormatter RFC_1123_FLEXIBLE = new DateTimeFormatterBuilder()
            .parseCaseInsensitive()
            .appendPattern("[EEE, ]dd MMM yyyy HH:mm:ss [zzz][XXX][z][Z]")
            .toFormatter(Locale.ENGLISH);

    private final Clock clock;

    public RssFeedParser() {
        this(Clock.systemDefaultZone());
    }

    public RssFeedParser(Clock clock) {
        this.clock = clock != null ? clock : Clock.systemDefaultZone();
    }

    /**
     * Parses an RSS 2.0 feed XML string into a list of normalized article items.
     */
    public List<NormalizedArticleItem> parse(String xmlContent, RssSourceConfig sourceConfig) throws Exception {
        if (xmlContent == null || xmlContent.isBlank()) {
            return List.of();
        }

        Document doc = createSecureDocumentBuilder().parse(new InputSource(new StringReader(xmlContent)));
        Element root = doc.getDocumentElement();

        // Atom check: skip Atom feeds with a WARN
        if ("feed".equalsIgnoreCase(root.getLocalName()) || "feed".equalsIgnoreCase(root.getNodeName())) {
            log.warn("Atom feed format detected for source '{}' - Atom feeds are skipped per specification", sourceConfig.getKey());
            return List.of();
        }

        if (!"rss".equalsIgnoreCase(root.getLocalName()) && !"rss".equalsIgnoreCase(root.getNodeName())) {
            log.warn("Non-RSS root element '{}' for source '{}'", root.getNodeName(), sourceConfig.getKey());
            return List.of();
        }

        NodeList items = doc.getElementsByTagName("item");
        List<NormalizedArticleItem> result = new ArrayList<>();
        Instant now = Instant.now(clock);

        int maxItems = sourceConfig != null && sourceConfig.getTypicalReadMinutes() > 0 ? 50 : 20;

        for (int i = 0; i < items.getLength(); i++) {
            Node itemNode = items.item(i);
            if (itemNode.getNodeType() != Node.ELEMENT_NODE) continue;
            Element itemElem = (Element) itemNode;

            // 1. Title
            String title = getFirstChildText(itemElem, "title");
            if (title == null || title.isBlank()) continue;
            title = stripHtml(title).trim();
            if (title.length() > 500) {
                title = title.substring(0, 500).trim();
            }

            // 2. Link
            String rawLink = getFirstChildText(itemElem, "link");
            String normalizedUrl = normalizeUrl(rawLink);
            if (normalizedUrl == null) {
                // Reject invalid or non-http/https link
                continue;
            }

            // 3. Description
            String rawDesc = getFirstChildText(itemElem, "description");
            String cleanSummary = cleanDescription(rawDesc);

            // 4. PubDate (RFC-1123, fallback to now, clamp future > 1 day)
            String rawPubDate = getFirstChildText(itemElem, "pubDate");
            Instant pubDate = parsePubDate(rawPubDate, now);

            // 5. Thumbnail (media:thumbnail, media:content, enclosure)
            String thumbnail = extractThumbnail(itemElem);

            // 6. Category
            String category = getFirstChildText(itemElem, "category");
            if (category == null || category.isBlank()) {
                category = sourceConfig != null ? sourceConfig.getCategory() : "World";
            } else {
                category = stripHtml(category).trim();
            }

            // 7. Level
            String level = sourceConfig != null ? sourceConfig.getDefaultLevel() : "B1";

            // 8. Full text & read_minutes
            String readingContent = null;
            int readMinutes = sourceConfig != null ? sourceConfig.getTypicalReadMinutes() : 3;

            boolean allowFullText = sourceConfig != null && "FULL_TEXT".equalsIgnoreCase(sourceConfig.getContentPolicy());
            if (allowFullText) {
                String rawContent = getNsChildText(itemElem, CONTENT_NS, "encoded");
                if (rawContent != null && !rawContent.isBlank()) {
                    readingContent = convertHtmlToParagraphs(rawContent);
                    if (!readingContent.isBlank()) {
                        int words = countWords(readingContent);
                        readMinutes = (int) Math.ceil(words / 200.0);
                    }
                }
            }

            NormalizedArticleItem articleItem = NormalizedArticleItem.builder()
                    .providerKey(sourceConfig != null ? sourceConfig.getKey() : null)
                    .source(sourceConfig != null && sourceConfig.getName() != null ? sourceConfig.getName() : "Unknown")
                    .title(title)
                    .url(normalizedUrl)
                    .thumbnail(thumbnail)
                    .summary(cleanSummary)
                    .category(category)
                    .level(level)
                    .readMinutes(Math.max(1, readMinutes))
                    .publishedAt(pubDate)
                    .readingContent(readingContent)
                    .build();

            result.add(articleItem);
        }

        return result;
    }

    private DocumentBuilder createSecureDocumentBuilder() throws Exception {
        DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
        dbf.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        dbf.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        dbf.setFeature("http://xml.org/sax/features/external-general-entities", false);
        dbf.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
        dbf.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        dbf.setXIncludeAware(false);
        dbf.setExpandEntityReferences(false);
        dbf.setNamespaceAware(true);
        return dbf.newDocumentBuilder();
    }

    public static String normalizeUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) return null;
        String trimmed = rawUrl.trim();
        try {
            URI uri = URI.create(trimmed);
            String scheme = uri.getScheme();
            if (scheme == null || (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https"))) {
                return null;
            }

            String query = uri.getQuery();
            String cleanQuery = null;
            if (query != null && !query.isBlank()) {
                StringBuilder sb = new StringBuilder();
                for (String param : query.split("&")) {
                    if (param.isBlank()) continue;
                    String[] parts = param.split("=", 2);
                    String key = parts[0].toLowerCase();
                    if (key.startsWith("utm_") || key.equals("fbclid") || key.equals("gclid") || key.equals("ocid")) {
                        continue;
                    }
                    if (sb.length() > 0) sb.append("&");
                    sb.append(param);
                }
                if (sb.length() > 0) cleanQuery = sb.toString();
            }

            URI cleanUri = new URI(scheme.toLowerCase(), uri.getAuthority(), uri.getPath(), cleanQuery, null);
            String result = cleanUri.toASCIIString();
            return result.length() <= 1000 ? result : null;
        } catch (Exception e) {
            return null;
        }
    }

    public static String cleanDescription(String rawHtml) {
        if (rawHtml == null || rawHtml.isBlank()) return "";
        String stripped = stripHtml(rawHtml);
        String decoded = decodeXmlEntities(stripped);
        String collapsed = decoded.replaceAll("\\s+", " ").trim();
        if (collapsed.length() <= 600) {
            return collapsed;
        }
        int cutIndex = collapsed.lastIndexOf(' ', 600);
        if (cutIndex <= 0) {
            cutIndex = 600;
        }
        return collapsed.substring(0, cutIndex).trim();
    }

    public static String stripHtml(String html) {
        if (html == null) return "";
        return html.replaceAll("<[^>]+>", " ");
    }

    public static String decodeXmlEntities(String text) {
        if (text == null) return "";
        return text.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&#39;", "'")
                .replace("&nbsp;", " ")
                .replace("&#8217;", "'")
                .replace("&#8216;", "'")
                .replace("&#8220;", "\"")
                .replace("&#8221;", "\"");
    }

    public static String convertHtmlToParagraphs(String html) {
        if (html == null) return "";
        String withBreaks = html.replaceAll("(?i)</p>", "\n\n")
                .replaceAll("(?i)<br\\s*/?>", "\n");
        String stripped = stripHtml(withBreaks);
        String decoded = decodeXmlEntities(stripped);
        // Normalize paragraph whitespace
        String[] paras = decoded.split("\n\n+");
        StringBuilder sb = new StringBuilder();
        for (String p : paras) {
            String clean = p.replaceAll("\\s+", " ").trim();
            if (!clean.isEmpty()) {
                if (sb.length() > 0) sb.append("\n\n");
                sb.append(clean);
            }
        }
        return sb.toString();
    }

    private Instant parsePubDate(String rawPubDate, Instant now) {
        if (rawPubDate == null || rawPubDate.isBlank()) {
            return now;
        }
        try {
            ZonedDateTime zdt = ZonedDateTime.parse(rawPubDate.trim(), DateTimeFormatter.RFC_1123_DATE_TIME);
            Instant instant = zdt.toInstant();
            if (instant.isAfter(now.plus(1, ChronoUnit.DAYS))) {
                return now; // Future clamp
            }
            return instant;
        } catch (Exception e1) {
            try {
                ZonedDateTime zdt = ZonedDateTime.parse(rawPubDate.trim(), RFC_1123_FLEXIBLE);
                Instant instant = zdt.toInstant();
                if (instant.isAfter(now.plus(1, ChronoUnit.DAYS))) {
                    return now;
                }
                return instant;
            } catch (Exception e2) {
                return now;
            }
        }
    }

    private String extractThumbnail(Element item) {
        // 1. media:thumbnail
        NodeList thumbnails = item.getElementsByTagNameNS(MEDIA_NS, "thumbnail");
        if (thumbnails.getLength() > 0 && thumbnails.item(0) instanceof Element thumbElem) {
            String url = thumbElem.getAttribute("url");
            if (isValidHttpsImageUrl(url)) return url.trim();
        }

        // 2. media:content (medium=image or type starts with image/)
        NodeList contents = item.getElementsByTagNameNS(MEDIA_NS, "content");
        for (int i = 0; i < contents.getLength(); i++) {
            if (contents.item(i) instanceof Element contentElem) {
                String medium = contentElem.getAttribute("medium");
                String type = contentElem.getAttribute("type");
                String url = contentElem.getAttribute("url");
                if (("image".equalsIgnoreCase(medium) || (type != null && type.startsWith("image/"))) && isValidHttpsImageUrl(url)) {
                    return url.trim();
                }
            }
        }

        // 3. enclosure
        NodeList enclosures = item.getElementsByTagName("enclosure");
        for (int i = 0; i < enclosures.getLength(); i++) {
            if (enclosures.item(i) instanceof Element encElem) {
                String type = encElem.getAttribute("type");
                String url = encElem.getAttribute("url");
                if (type != null && type.startsWith("image/") && isValidHttpsImageUrl(url)) {
                    return url.trim();
                }
            }
        }

        return null;
    }

    private boolean isValidHttpsImageUrl(String url) {
        if (url == null || url.isBlank()) return false;
        String trimmed = url.trim();
        return trimmed.startsWith("https://") && trimmed.length() <= 1000;
    }

    private String getFirstChildText(Element parent, String tagName) {
        NodeList list = parent.getElementsByTagName(tagName);
        if (list.getLength() > 0 && list.item(0) != null) {
            return list.item(0).getTextContent();
        }
        return null;
    }

    private String getNsChildText(Element parent, String ns, String localName) {
        NodeList list = parent.getElementsByTagNameNS(ns, localName);
        if (list.getLength() > 0 && list.item(0) != null) {
            return list.item(0).getTextContent();
        }
        return null;
    }

    private int countWords(String text) {
        if (text == null || text.isBlank()) return 0;
        return text.trim().split("\\s+").length;
    }
}
