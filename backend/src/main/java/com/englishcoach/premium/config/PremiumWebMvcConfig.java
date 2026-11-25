package com.englishcoach.premium.config;

import com.englishcoach.premium.interceptor.PremiumFeatureGatingInterceptor;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
@RequiredArgsConstructor
public class PremiumWebMvcConfig implements WebMvcConfigurer {

    private final PremiumFeatureGatingInterceptor gatingInterceptor;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(gatingInterceptor)
                .addPathPatterns("/api/**");
    }
}
