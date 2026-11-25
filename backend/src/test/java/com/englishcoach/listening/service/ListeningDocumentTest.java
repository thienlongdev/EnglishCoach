package com.englishcoach.listening.service;

import com.englishcoach.speaking.service.SpeakingTtsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import javax.sound.sampled.*;
import java.nio.file.*;
import java.io.*;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

class ListeningDocumentTest {
    @TempDir Path temp;
    static byte[] wav(int frames) throws Exception {
        AudioFormat f=new AudioFormat(24000,16,1,true,false);
        byte[] pcm=new byte[frames*2];
        // Test fixture only; production always obtains bytes from the real provider.
        for(int i=0;i<frames;i++){short value=(short)(Math.sin(i*.1)*1000);pcm[i*2]=(byte)value;pcm[i*2+1]=(byte)(value>>8);}
        ByteArrayOutputStream result=new ByteArrayOutputStream();
        try(var stream=new AudioInputStream(new ByteArrayInputStream(pcm),f,frames)) {AudioSystem.write(stream,AudioFileFormat.Type.WAVE,result);}
        return result.toByteArray();
    }
    @Test void confirmedTextAndSentenceBoundaries() {
        String text="Dr. Smith arrived at 8:30. He brought three books!\n\nWe read them together.";
        String validated=ListeningPassage.validate(text);
        assertThat(validated).isEqualTo(text);
        assertThat(String.join(" ",ListeningPassage.segments(text))).isEqualTo(text.replace("\n\n"," "));
        assertThat(ListeningPassage.fingerprint("us_male",text)).isNotEqualTo(ListeningPassage.fingerprint("uk_male",text));
    }
    @Test void blankNonEnglishAndLongWorkloadRejected() {
        for(String invalid:List.of("", "Tiếng Việt cần được kiểm tra thật kỹ.","x".repeat(3001),"A sentence with many words ".repeat(30),"Short English sentence. ".repeat(17)))
            assertThatThrownBy(()->ListeningPassage.validate(invalid)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
    }
    @Test void measuredFramesDurableWavAndPrivatePaths() throws Exception {
        var storage=new ListeningDocumentAudio(temp); var a=storage.decode(wav(24017));var b=storage.decode(wav(48019));
        assertThat(a.millis()).isEqualTo(1001);UUID id=UUID.randomUUID();storage.save(1L,id,List.of(a,b));
        var resource=storage.load(1L,id);
        try(var stream=AudioSystem.getAudioInputStream(new BufferedInputStream(resource.getInputStream()))) {assertThat(stream.getFrameLength()).isEqualTo(72036);}
        assertThatThrownBy(()->storage.load(2L,id)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        storage.delete(1L,id);assertThatThrownBy(()->storage.load(1L,id)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
    }
    @Test void invalidProviderMediaAndOversizedDurationRejected() throws Exception {
        var storage=new ListeningDocumentAudio(temp);
        assertThatThrownBy(()->storage.decode("not audio".getBytes())).isInstanceOf(IOException.class);
        assertThatThrownBy(()->storage.decode(wav(24000*61))).isInstanceOf(IOException.class);
        assertThat(SpeakingTtsService.CANONICAL_VOICES).extracting(SpeakingTtsService.VoiceMetaDto::voiceId)
                .containsExactly("us_male","us_female","uk_male","uk_female");
    }
}
