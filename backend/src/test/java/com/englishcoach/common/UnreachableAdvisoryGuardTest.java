package com.englishcoach.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Six advisories remain against the runtime classpath after the 2026-10 releases, all in code paths this
 * application does not have (docs/security/final-security-v3-2026-10/09-DEVSECOPS-CVE-SBOM-AND-TEST-EVIDENCE.md).
 * "Not reachable" is only true while the source keeps not using those features: this test fails the day one of
 * them appears, so the exception is re-examined instead of silently becoming wrong.
 *
 * <ul>
 *   <li>GHSA-pc63-qcmh-9cmg (Spring MVC {@code XsltView}) — no XSLT view is configured or returned;</li>
 *   <li>GHSA-j9f9-w8pj-32f8 (Spring MVC fragment rendering over Server-Sent Events) — no fragment rendering;</li>
 *   <li>GHSA-prj3-ccx8-p6x4 (gRPC Netty HTTP/2 server) — the application starts no gRPC server (the jar comes with
 *       LanguageTool as a client library);</li>
 *   <li>GHSA-659w-93r5-9j6m (OpenNLP model reader) — models are the ones bundled with LanguageTool; nothing loads a
 *       model from a caller's data;</li>
 *   <li>GHSA-rcgg-9c38-7xpx (OpenTelemetry W3C baggage propagation) — no OpenTelemetry SDK or propagator is set up;</li>
 *   <li>GHSA-qv9r-c865-cp47 (Log4j API {@code MapMessage} JSON) — logging is Logback; no {@code MapMessage}.</li>
 * </ul>
 */
class UnreachableAdvisoryGuardTest {

    private static final Path MAIN = Path.of("src/main/java");
    private static final Path RESOURCES = Path.of("src/main/resources");

    private static List<String> filesMentioning(Path root, String suffix, Pattern pattern) throws IOException {
        List<String> hits = new ArrayList<>();
        try (Stream<Path> files = Files.walk(root)) {
            for (Path file : (Iterable<Path>) files.filter(p -> p.toString().endsWith(suffix))::iterator) {
                if (pattern.matcher(Files.readString(file)).find()) hits.add(root.relativize(file).toString());
            }
        }
        return hits;
    }

    @Test
    @DisplayName("Spring MVC: no XSLT view and no fragment rendering anywhere in the application")
    void noXsltViewAndNoFragmentRendering() throws IOException {
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("XsltView|XsltViewResolver|FragmentsRendering|\\.xsl\\b|\\.xslt\\b")))
                .as("GHSA-pc63-qcmh-9cmg / GHSA-j9f9-w8pj-32f8 would become reachable").isEmpty();
        assertThat(filesMentioning(RESOURCES, ".yml", Pattern.compile("(?i)xslt|spring\\.mvc\\.view")))
                .as("no view resolver configuration").isEmpty();
        try (Stream<Path> files = Files.walk(RESOURCES)) {
            assertThat(files.filter(p -> p.toString().endsWith(".xsl") || p.toString().endsWith(".xslt")).toList())
                    .as("no stylesheet is packaged").isEmpty();
        }
    }

    @Test
    @DisplayName("No gRPC server, no OpenNLP model loading, no OpenTelemetry SDK, no Log4j MapMessage in application code")
    void transitiveLibrariesAreNotDrivenByApplicationCode() throws IOException {
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("import\\s+io\\.grpc\\.|ServerBuilder|NettyServerBuilder")))
                .as("GHSA-prj3-ccx8-p6x4: a gRPC server would make the HTTP/2 advisory reachable").isEmpty();
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("import\\s+opennlp\\.|AbstractModelReader|TokenizerModel|POSModel")))
                .as("GHSA-659w-93r5-9j6m: application code must not load OpenNLP models").isEmpty();
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("import\\s+io\\.opentelemetry\\.")))
                .as("GHSA-rcgg-9c38-7xpx: no OpenTelemetry propagation is set up").isEmpty();
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("org\\.apache\\.logging\\.log4j|MapMessage")))
                .as("GHSA-qv9r-c865-cp47: logging goes through SLF4J / Logback").isEmpty();
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("import\\s+org\\.json\\.")))
                .as("DEP-04: JSON parsing uses Jackson ObjectMapper, never org.json").isEmpty();
        assertThat(filesMentioning(MAIN, ".java", Pattern.compile("import\\s+com\\.google\\.common\\.")))
                .as("DEP-04: application code must not call transitive Guava utilities directly").isEmpty();
    }

    @Test
    @DisplayName("EchoLifeWorkshop GraalJS sandbox never enables host, IO, native, or thread privileges")
    void echoLifeWorkshopSandboxRemainsLockedDown() throws IOException {
        Path workshop = MAIN.resolve("com/englishcoach/echolife/EchoLifeWorkshop.java");
        assertThat(workshop).exists();
        String source = Files.readString(workshop);
        assertThat(source)
                .as("EchoLifeWorkshop must keep allowAllAccess(false)")
                .contains("allowAllAccess(false)");
        assertThat(source)
                .as("EchoLifeWorkshop must never grant host, IO, native, or thread access to GraalJS contexts")
                .doesNotContain("allowHostAccess")
                .doesNotContain("allowIO")
                .doesNotContain("allowNativeAccess")
                .doesNotContain("allowCreateThread")
                .doesNotContain("allowAllAccess(true)");
    }
}
