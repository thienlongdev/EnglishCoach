package com.englishcoach.reading;

import com.englishcoach.reading.controller.ReadingCorpusController;
import com.englishcoach.reading.service.ReadingCorpusImporter;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Exercises real method-security proxies without an application DB or web server. */
class ReadingCorpusAuthorizationTest {
    @Configuration
    @EnableMethodSecurity
    static class Config {
        @Bean ReadingCorpusImporter importer() { return mock(ReadingCorpusImporter.class); }
        @Bean ReadingCorpusController controller(ReadingCorpusImporter importer) { return new ReadingCorpusController(importer); }
    }
    @Test void onlyAdminCanInvokeEvenDryRun() {
        try (var context=new AnnotationConfigApplicationContext(Config.class)) {
            var controller=context.getBean(ReadingCorpusController.class);
            var importer=context.getBean(ReadingCorpusImporter.class);
            var request=new ReadingCorpusController.Request(false,false,null);
            SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken("user","unused",List.of(new SimpleGrantedAuthority("ROLE_USER"))));
            assertThatThrownBy(() -> controller.run(request)).isInstanceOf(AccessDeniedException.class);
            verifyNoInteractions(importer);
            SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken("admin","unused",List.of(new SimpleGrantedAuthority("ROLE_ADMIN"))));
            var result=new ReadingCorpusImporter.Result("digest",false,150,150,0,0);
            when(importer.run(false,false,null)).thenReturn(result);
            assertThat(controller.run(request).getBody()).isEqualTo(result);
            verify(importer).run(false,false,null);
        } finally { SecurityContextHolder.clearContext(); }
    }
}
