package com.englishcoach.common;

import com.englishcoach.flashcard.pvp.model.ScheduledWord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.RegexPatternTypeFilter;

import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Every class the application sends or receives as JSON must have ONE unambiguous JSON shape. A library upgrade that
 * starts to refuse a property definition (as Jackson 2.21 did for a model with two getters for one property) would
 * otherwise show up only when that message is first sent in production. Building the serializer and the deserializer
 * of a class needs no instance and no database, so the whole payload surface is checked here.
 */
class JsonContractIntrospectionTest {

    /** Packages whose classes are JSON payloads: REST bodies, STOMP messages, events sent to clients. */
    private static final Pattern PAYLOAD_TYPES =
            Pattern.compile("com\\.englishcoach\\..*\\.(dto|model|payload|api|event|view|response|request)\\..*");

    private static ObjectMapper mapper() {
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);
    }

    private static List<Class<?>> payloadClasses() throws Exception {
        ClassPathScanningCandidateComponentProvider scanner = new ClassPathScanningCandidateComponentProvider(false) {
            @Override
            protected boolean isCandidateComponent(
                    org.springframework.beans.factory.annotation.AnnotatedBeanDefinition definition) {
                return true; // nested classes and records too, not only top-level concrete components
            }
        };
        scanner.addIncludeFilter(new RegexPatternTypeFilter(PAYLOAD_TYPES));
        List<Class<?>> classes = new ArrayList<>();
        for (BeanDefinition definition : scanner.findCandidateComponents("com.englishcoach")) {
            Class<?> type;
            try {
                type = Class.forName(definition.getBeanClassName(), false, getClass0().getClassLoader());
            } catch (Throwable notLoadable) {
                continue;
            }
            if (type.isAnnotation() || type.isAnonymousClass() || type.isSynthetic()
                    || type.getSimpleName().endsWith("Builder") || type.getSimpleName().endsWith("BuilderImpl")
                    || type.getName().contains("Test")) {
                continue;
            }
            classes.add(type);
        }
        return classes;
    }

    private static Class<?> getClass0() {
        return JsonContractIntrospectionTest.class;
    }

    @Test
    @DisplayName("Every payload class has an unambiguous serializer")
    void everyPayloadClassCanBeSerialized() throws Exception {
        ObjectMapper mapper = mapper();
        List<Class<?>> classes = payloadClasses();
        assertThat(classes.size()).as("the scan found the payload classes").isGreaterThan(300);

        TreeSet<String> broken = new TreeSet<>();
        for (Class<?> type : classes) {
            try {
                mapper.getSerializerProviderInstance().findValueSerializer(type);
            } catch (Throwable problem) {
                broken.add(type.getName() + " -> " + firstLine(problem));
            }
        }
        assertThat(broken).as("payload classes whose JSON shape is ambiguous or invalid").isEmpty();
    }

    @Test
    @DisplayName("Every concrete payload class the server reads has an unambiguous deserializer")
    void everyConcretePayloadClassCanBeDeserialized() throws Exception {
        ObjectMapper mapper = mapper();
        TreeSet<String> broken = new TreeSet<>();
        for (Class<?> type : payloadClasses()) {
            if (type.isInterface() || type.isEnum() || Modifier.isAbstract(type.getModifiers())
                    || (type.isMemberClass() && !Modifier.isStatic(type.getModifiers()))) {
                continue;
            }
            try {
                mapper.readValue("{}", type); // builds the deserializer; an empty object needs no data
            } catch (Throwable problem) {
                String message = firstLine(problem);
                // A missing creator or a required value only says "{}" is not a valid instance of this class.
                // What must never happen is a class whose property definitions conflict.
                if (message.contains("Conflicting") || message.contains("ambiguous")) {
                    broken.add(type.getName() + " -> " + message);
                }
            }
        }
        assertThat(broken).as("payload classes with conflicting property definitions").isEmpty();
    }

    @Test
    @DisplayName("Card Blast PvP word keeps all four flag names on the wire")
    void scheduledWordKeepsItsWireNames() throws Exception {
        ScheduledWord word = ScheduledWord.builder().seq(1).wordId(7L).word("apple").isGarbage(true).isGolden(false).build();

        JsonNode json = mapper().readTree(mapper().writeValueAsString(word));

        assertThat(json.get("isGarbage").asBoolean()).isTrue();
        assertThat(json.get("garbage").asBoolean()).isTrue();
        assertThat(json.get("isGolden").asBoolean()).isFalse();
        assertThat(json.get("golden").asBoolean()).isFalse();
        assertThat(json.get("word").asText()).isEqualTo("apple");
    }

    private static String firstLine(Throwable problem) {
        String message = String.valueOf(problem.getMessage());
        int newline = message.indexOf('\n');
        return (newline > 0 ? message.substring(0, newline) : message).trim();
    }
}
