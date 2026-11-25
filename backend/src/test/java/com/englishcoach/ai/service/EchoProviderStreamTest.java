package com.englishcoach.ai.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

class EchoProviderStreamTest {
    private final ObjectMapper json = new ObjectMapper();
    private String frame(Map<String,Object> delta, String finish) throws Exception {
        Map<String,Object> choice = new HashMap<>(Map.of("index",0,"delta",delta));
        choice.put("finish_reason",finish);
        return "data: " + json.writeValueAsString(Map.of("choices", List.of(choice))) + "\r\n\r\n";
    }
    private static InputStream fragments(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)) {
            @Override public synchronized int read(byte[] b,int off,int len) { return super.read(b,off,Math.min(len,2)); }
        };
    }
    @Test void vietnameseArrivesBeforeCompletionAndUsageSurvives() throws Exception {
        var visible = new ArrayList<String>();
        var gate = new EchoVisibleText("private",EchoPolicy.Intent.GRAMMAR,visible::add);
        String a = "Dùng thì quá khứ đơn với hành động đã kết thúc. ".repeat(4);
        String b = "She visited Hue last year.";
        var usage = new ArrayList<Map<?,?>>();
        String stream = ": ping\r\n\r\n" + frame(Map.of("content",a, "reasoning","PRIVATE"),null)
                + frame(Map.of("content",b),"stop") + "data: {\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}],\"usage\":{\"cost\":0.001}}\n\ndata: [DONE]\n\n";
        var result = EchoProviderStream.parse(fragments(stream),json,new EchoProviderStream.Control(),gate::advance,usage::add,()->{});
        assertThat(visible).isNotEmpty();
        assertThat(String.join("",visible)).doesNotContain("PRIVATE",b);
        gate.finish(a+b);
        assertThat(String.join("",visible)).isEqualTo(a+b);
        assertThat(usage.getFirst().get("cost")).isEqualTo(0.001);
        assertThat(result.toString()).doesNotContain("PRIVATE");
    }
    @Test void privateToolFragmentsRemainSeparateAndTruncationFails() throws Exception {
        var p1 = Map.of("index",0,"id","call_1","function",Map.of("name","search_lessons","arguments","{\"module\":"));
        var p2 = Map.of("index",0,"function",Map.of("arguments","\"reading\"}"));
        String stream = frame(Map.of("tool_calls",List.of(p1)),null) + frame(Map.of("tool_calls",List.of(p2)),"tool_calls") + "data: [DONE]\n\n";
        var result = EchoProviderStream.parse(fragments(stream),json,new EchoProviderStream.Control(),null,u->{},()->{});
        assertThat(result.toString()).contains("{\"module\":\"reading\"}");
        assertThatThrownBy(()-> EchoProviderStream.parse(fragments(stream),json,new EchoProviderStream.Control(),t->{},u->{},()->{})).isInstanceOf(IOException.class);
        assertThatThrownBy(()-> EchoProviderStream.parse(fragments(frame(Map.of("content","Hi"),null)),json,new EchoProviderStream.Control(),t->{},u->{},()->{})).isInstanceOf(IOException.class);
    }
    @Test void cancellationClosesBodyAndInvalidatesFurtherRounds() throws Exception {
        var c = new EchoProviderStream.Control();
        var closed = new java.util.concurrent.atomic.AtomicBoolean();
        c.attach(new ByteArrayInputStream(new byte[0]) { @Override public void close() { closed.set(true); } });
        c.cancel();
        assertThat(closed).isTrue();
        assertThatThrownBy(c::check).isInstanceOf(java.util.concurrent.CancellationException.class);
    }
    @Test void withheldSplitSignatureNeverReachesListener() {
        var visible = new ArrayList<String>();
        var gate = new EchoVisibleText("private",EchoPolicy.Intent.GRAMMAR,visible::add);
        String a = "A useful introductory sentence. ".repeat(9)+"developer ";
        gate.advance(a);
        assertThatThrownBy(()->gate.advance(a+"instructions "+"more text ".repeat(8))).isInstanceOf(EchoVisibleText.Filtered.class);
        assertThat(String.join("",visible)).doesNotContain("developer");
    }
}
