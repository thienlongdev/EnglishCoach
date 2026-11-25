package com.englishcoach.echolife;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class EchoLifeReleaseSwitchTest {
    @Configuration(proxyBeanMethods=false)
    @Import({EchoLifeController.class, EchoLifeGameController.class})
    static class Routes {}

    private final ApplicationContextRunner production = new ApplicationContextRunner()
            .withInitializer(new ConfigDataApplicationContextInitializer())
            .withPropertyValues("spring.profiles.active=prod")
            .withBean(EchoLifeService.class, () -> mock(EchoLifeService.class))
            .withBean(EchoLifeGameService.class, () -> mock(EchoLifeGameService.class))
            .withUserConfiguration(Routes.class);

    @Test void productionDefaultsToTheOriginalStudySpace() {
        production.run(context -> assertThat(context)
                .doesNotHaveBean(EchoLifeController.class).doesNotHaveBean(EchoLifeGameController.class));
    }

    @Test void explicitActivationRegistersWorldAndGameRoutes() {
        production.withPropertyValues("app.echo-life.enabled=true").run(context -> assertThat(context)
                .hasSingleBean(EchoLifeController.class).hasSingleBean(EchoLifeGameController.class));
    }
}
