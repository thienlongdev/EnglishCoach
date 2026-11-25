package com.englishcoach.common.web;

import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import com.englishcoach.writing.service.LanguageToolGrammarService;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
public class CoreReadinessConfig {
    @Bean
    public FilterRegistrationBean<CoreReadinessFilter> coreReadinessRegistration(
            ApplicationAvailability availability, LocalEnViLexicalProvider dictionary,
            LanguageToolGrammarService grammar) {
        var registration = new FilterRegistrationBean<>(new CoreReadinessFilter(availability, dictionary, grammar));
        registration.addUrlPatterns("/api/v1/exams/capabilities");
        return registration;
    }
}
