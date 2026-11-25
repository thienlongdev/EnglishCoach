package com.englishcoach.exams.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * Authoritative generator of IELTS Speaking simulation turn sets.
 *
 * Requirements:
 * 1. Canonical structure: Part 1 (4 turns), Part 2 (1 cue card), Part 3 (4 discussion turns) = 9 turns.
 * 2. Immutable & deterministic: Seeded by hash(form_version_id + "_speaking_v1").
 * 3. Never copy Cambridge 14 Test 1 questions to other tests.
 * 4. Explicit provenance: "SOURCE_DERIVED" if extracted from genuine source material,
 *    "GENERATED_SIMULATION_TURN" for high-fidelity generated simulation content.
 * 5. Cambridge IELTS 14 Test 1 remains reference anchor with its examiner video assets.
 */
public final class ExamSpeakingTurnGenerator {

    public record SpeakingTopicSet(
            String topicFamily,
            String[] part1Prompts,
            String part2CuePrompt,
            String[] part3Prompts
    ) {}

    public record SpeakingTurnPlan(
            String topicFamily,
            String provenance,
            String[] part1Prompts,
            String part2CuePrompt,
            String[] part3Prompts,
            String[] part1MediaUrls,
            String part2MediaUrl,
            String[] part3MediaUrls
    ) {}

    // Reference Cambridge 14 Test 1 Topic Set (Topic 0)
    private static final SpeakingTopicSet REFERENCE_TOPIC_SET = new SpeakingTopicSet(
            "Home, Routines & Modern Learning",
            new String[] {
                    "Let's talk about where you live. Do you live in a house or an apartment?",
                    "What do you like most about your hometown or neighbourhood?",
                    "Let's move on to talk about daily routines. What is your favourite part of the day?",
                    "Do you prefer to spend your free time indoors or outdoors? Why?"
            },
            "Describe something important that you learned recently. You should say: what you learned, how you learned it, why it was important, and explain how it affected your daily life.",
            new String[] {
                    "How has the way people learn changed compared to the past?",
                    "Do you think modern technology has made it easier or more difficult for people to concentrate while studying?",
                    "Some people believe that self-directed learning is more effective than formal education. What is your opinion?",
                    "In the future, do you think traditional schools and universities will still play a central role in education?"
            }
    );

    // Diverse, coherent topic catalog for IELTS simulation forms (Topics 1 - 16)
    private static final List<SpeakingTopicSet> SIMULATION_TOPIC_SETS = List.of(
            // 1. Travel & Tourism
            new SpeakingTopicSet(
                    "Travel, Tourism & Cross-Cultural Experiences",
                    new String[] {
                            "Do you enjoy travelling to new places? Why or why not?",
                            "What kind of transport do you usually prefer when you go on a long trip?",
                            "Do you prefer travelling alone or with friends and family?",
                            "Which destination in your country would you recommend to a foreign visitor?"
                    },
                    "Describe a memorable journey or trip you took that was particularly special. You should say: where you went, who you travelled with, what you did during the trip, and explain why this journey was memorable to you.",
                    new String[] {
                            "How has international tourism affected local cultures and traditions in your country?",
                            "What measures can governments take to promote eco-friendly or sustainable tourism?",
                            "Do you think people in the future will travel abroad more frequently or less frequently?",
                            "Some argue that travelling to foreign countries is essential for personal growth. To what extent do you agree?"
                    }
            ),

            // 2. Environment & Climate
            new SpeakingTopicSet(
                    "Environmental Protection & Natural Spaces",
                    new String[] {
                            "Are there many public parks or green spaces in your hometown?",
                            "Do you prefer spending time near water, such as a beach, lake, or river?",
                            "What do you or your family do at home to help protect the environment?",
                            "How has the weather in your local region changed in recent years?"
                    },
                    "Describe an environmental problem in your city or country that concerns you. You should say: what the problem is, what causes it, how it affects people's daily lives, and explain what actions can be taken to solve it.",
                    new String[] {
                            "Who should bear the main responsibility for addressing climate change: individuals or large corporations?",
                            "How effective are educational campaigns in schools at encouraging recycling and conservation?",
                            "Do you think modern economies can continue to grow without harming the natural environment?",
                            "What major environmental challenges do you think the next generation will face?"
                    }
            ),

            // 3. Technology & Artificial Intelligence
            new SpeakingTopicSet(
                    "Technology, Digital Devices & Future Society",
                    new String[] {
                            "What electronic device do you rely on most in your daily routine?",
                            "Do you prefer communicating with friends through messaging apps or speaking face-to-face?",
                            "How much time do you spend using the internet each day?",
                            "Did you learn to use computers at an early age?"
                    },
                    "Describe a piece of technology or an electronic device that you find extremely useful. You should say: what device it is, when you got it, how you use it in your daily life, and explain why it is so valuable to you.",
                    new String[] {
                            "In what ways has artificial intelligence begun to change everyday workplace practices?",
                            "Do you believe that increasing reliance on smartphones has reduced people's attention spans?",
                            "How can parents and educators ensure that young children develop healthy screen time habits?",
                            "What ethical challenges arise when algorithms make decisions that affect human lives?"
                    }
            ),

            // 4. Health, Sports & Well-being
            new SpeakingTopicSet(
                    "Health, Physical Fitness & Modern Well-being",
                    new String[] {
                            "What kinds of physical exercise do you enjoy doing regularly?",
                            "Do you prefer participating in team sports or individual physical activities?",
                            "How easy is it to maintain a balanced and healthy diet where you live?",
                            "What do you usually do to relax when you feel stressed from work or study?"
                    },
                    "Describe a healthy habit or activity you have adopted to stay active. You should say: what the activity is, when and where you do it, how often you do it, and explain how it benefits your physical or mental health.",
                    new String[] {
                            "Why are lifestyle-related health problems becoming more prevalent in modern urban societies?",
                            "Should public governments invest more heavily in preventative healthcare or hospital treatment facilities?",
                            "How does workplace stress influence an employee's long-term physical well-being?",
                            "Do you think professional athletes have a duty to serve as positive health role models for youth?"
                    }
            ),

            // 5. Work, Careers & Modern Economy
            new SpeakingTopicSet(
                    "Work, Professional Careers & Workplace Culture",
                    new String[] {
                            "Are you currently studying or working in a professional field?",
                            "What qualities do you think make someone successful in their job?",
                            "Do you prefer working independently or collaborating within a team?",
                            "What is your ideal working environment?"
                    },
                    "Describe a career or profession that you find admirable or fascinating. You should say: what career it is, what qualifications and skills it requires, what daily responsibilities it involves, and explain why you admire this profession.",
                    new String[] {
                            "How has the widespread adoption of remote work impacted team productivity and workplace culture?",
                            "What skills will be most crucial for workers to remain competitive in the future global economy?",
                            "Do you think achieving a healthy work-life balance is harder today than it was in previous generations?",
                            "Some people believe salary is the most important factor when choosing a career. What is your opinion?"
                    }
            ),

            // 6. Art, Architecture & Creative Design
            new SpeakingTopicSet(
                    "Art, Architecture & Aesthetic Design",
                    new String[] {
                            "Do you often visit art galleries, museums, or historical exhibitions?",
                            "What kind of architectural styles of buildings do you find most appealing?",
                            "Did you enjoy drawing or making things by hand when you were a child?",
                            "Is there a building in your city that you consider particularly beautiful?"
                    },
                    "Describe an impressive building or architectural structure that you have seen. You should say: where this building is located, what it looks like, what its primary purpose is, and explain why you found its design impressive.",
                    new String[] {
                            "Why is it important for cities to preserve historic buildings rather than replacing them with modern high-rises?",
                            "Should public funding be allocated to support contemporary artists and public art installations?",
                            "How does the visual design of urban spaces influence the happiness and behavior of citizens?",
                            "Do you think architecture in the future will prioritize environmental sustainability over artistic expression?"
                    }
            ),

            // 7. Food, Cooking & Culinary Heritage
            new SpeakingTopicSet(
                    "Food Culture, Cooking Traditions & Nutrition",
                    new String[] {
                            "What is your favourite type of food or traditional cuisine?",
                            "Do you enjoy cooking your own meals at home or eating out at restaurants?",
                            "Who taught you how to prepare your first meal?",
                            "How has the food people eat in your country changed over the past few decades?"
                    },
                    "Describe a memorable meal or culinary experience you had with family or friends. You should say: where you had this meal, what dishes were served, who was with you, and explain why this dining experience was memorable.",
                    new String[] {
                            "How has the rise of international fast-food chains affected traditional culinary cultures?",
                            "What role does sharing food play in strengthening relationships between families and communities?",
                            "How can governments and communities reduce the large amount of food waste generated in modern cities?",
                            "Do you believe that cooking and nutrition should be compulsory subjects in secondary school curriculums?"
                    }
            ),

            // 8. Literature, Reading & Public Libraries
            new SpeakingTopicSet(
                    "Books, Reading Habits & Intellectual Growth",
                    new String[] {
                            "How often do you read books, magazines, or online long-form articles?",
                            "Do you prefer reading printed physical books or using digital e-readers?",
                            "What was your favourite story or book when you were growing up?",
                            "Where is your favourite place to sit down and read comfortably?"
                    },
                    "Describe a book that made a strong impression on you or influenced your thinking. You should say: what book it is, who wrote it, what the story or theme is about, and explain why it made such a deep impression on you.",
                    new String[] {
                            "Do you think reading books will remain popular among future generations given the growth of short-form video media?",
                            "What role do public libraries play in the digital information age when most content is accessible online?",
                            "Does reading fiction provide more cognitive and empathetic benefits to readers than non-fiction?",
                            "How can parents encourage their children to develop a lifelong passion for voluntary reading?"
                    }
            ),

            // 9. Friendship, Community & Social Dynamics
            new SpeakingTopicSet(
                    "Friendship, Neighborhoods & Social Cohesion",
                    new String[] {
                            "How do you usually stay in touch with your close friends?",
                            "Do you find it easy to start conversations with new acquaintances?",
                            "Do you know your neighbours well, and do you frequently interact with them?",
                            "What qualities do you value most in a true friend?"
                    },
                    "Describe a close friend who has had a positive influence on your personal life. You should say: who this friend is, how long you have known each other, what activities you do together, and explain how this person has positively influenced you.",
                    new String[] {
                            "How has social media altered the quality and depth of human friendships in modern times?",
                            "Why do people in large modern apartment complexes often feel more isolated than those in smaller rural communities?",
                            "What benefits do volunteer community organizations provide to local neighborhoods?",
                            "Do you think intergenerational relationships between youth and senior citizens are being weakened in contemporary society?"
                    }
            ),

            // 10. Commerce, Consumer Behavior & Fashion
            new SpeakingTopicSet(
                    "Consumerism, Retail Shopping & Personal Style",
                    new String[] {
                            "Do you prefer shopping online or visiting physical retail stores in person?",
                            "How important is personal fashion and clothing style to you?",
                            "Do you usually read consumer reviews before purchasing a new product?",
                            "What was the last item you bought that you were really satisfied with?"
                    },
                    "Describe an item you bought recently that was particularly useful or important to you. You should say: what the item is, where and why you bought it, how frequently you use it, and explain why you feel satisfied with your purchase.",
                    new String[] {
                            "How does targeted social media advertising influence consumer purchasing habits, especially among youth?",
                            "What environmental problems are associated with the global 'fast fashion' business model?",
                            "Will physical shopping malls and traditional brick-and-mortar stores survive in the next twenty years?",
                            "Some argue that material possessions do not contribute to long-term happiness. What is your perspective?"
                    }
            ),

            // 11. History, National Heritage & Cultural Festivals
            new SpeakingTopicSet(
                    "Historical Heritage, Public Festivals & National Identity",
                    new String[] {
                            "Did you find history classes interesting when you were at school?",
                            "What is the most important national holiday or traditional festival in your country?",
                            "Do you enjoy watching historical documentary films or television series?",
                            "Have you ever visited a famous historical site or battlefield in your country?"
                    },
                    "Describe a traditional festival or national cultural celebration that is important in your country. You should say: what the festival is, when it takes place, what customs and activities are performed, and explain why it is meaningful to the community.",
                    new String[] {
                            "Why is it essential for children to learn about both national history and world history in school?",
                            "Has commercialization weakened the cultural significance of traditional annual celebrations?",
                            "How can governments safeguard intangible cultural heritage, such as folklore, craftsmanship, and local dialects?",
                            "Do you believe that museums should be free for all citizens to ensure equal access to historical knowledge?"
                    }
            ),

            // 12. Communication, Languages & Global Exchange
            new SpeakingTopicSet(
                    "Language Learning, Interpersonal Communication & Global Dialogue",
                    new String[] {
                            "How many languages can you speak, and which language would you like to learn next?",
                            "Do you prefer making phone calls or sending text messages when communicating with friends?",
                            "Have you ever had to give a speech or presentation in front of a large audience?",
                            "What do you find most challenging when learning to speak a foreign language fluently?"
                    },
                    "Describe an interesting conversation you had with someone from a different background or culture. You should say: who you spoke with, where and when the conversation took place, what topics you discussed, and explain why you found the dialogue enlightening.",
                    new String[] {
                            "Will automated real-time translation technology make learning foreign languages obsolete in the future?",
                            "How does the dominance of international languages like English affect minority language survival?",
                            "Why is non-verbal communication, such as body language and facial expressions, critical in cross-cultural diplomacy?",
                            "In what ways does learning a foreign language broaden an individual's worldview and critical thinking skills?"
                    }
            ),

            // 13. Science, Space Exploration & Inventions
            new SpeakingTopicSet(
                    "Scientific Discoveries, Space Research & Daily Inventions",
                    new String[] {
                            "Were you interested in science subjects such as physics or chemistry at school?",
                            "What everyday household invention do you think saves the most time?",
                            "Do you enjoy watching news or documentaries about outer space exploration?",
                            "If you could invent one machine to help humanity, what would it do?"
                    },
                    "Describe a scientific invention or technological discovery that has revolutionized society. You should say: what the invention is, who created it or when it emerged, how it operates in daily life, and explain why it has had such a massive impact.",
                    new String[] {
                            "Should national governments invest billions into outer space exploration while major social problems exist on Earth?",
                            "How can scientific research be conducted ethically to prevent harm to vulnerable communities or ecosystems?",
                            "What measures should be taken to encourage more young women to pursue careers in STEM disciplines?",
                            "How can the public distinguish between credible scientific research and misleading sensationalized claims online?"
                    }
            ),

            // 14. Transportation, Public Commuting & Infrastructure
            new SpeakingTopicSet(
                    "Public Mobility, Urban Transportation & Commuter Life",
                    new String[] {
                            "How do you usually commute to work, university, or school every day?",
                            "Is public transportation reliable and affordable in your home city?",
                            "Do many people in your neighborhood ride bicycles for commuting or leisure?",
                            "What is traffic congestion like during morning and evening rush hours where you live?"
                    },
                    "Describe an interesting or memorable journey you took using public transportation. You should say: what kind of vehicle you travelled on, where you were going, who was travelling with you, and explain why that journey stands out in your memory.",
                    new String[] {
                            "How can city planners effectively motivate citizens to switch from private cars to public transit systems?",
                            "What role will electric vehicles and autonomous self-driving cars play in reducing urban carbon emissions?",
                            "Should public transit services, such as metro systems and buses, be completely subsidized and free for commuters?",
                            "How does long daily commuting time impact an individual's mental health, stress levels, and family life?"
                    }
            ),

            // 15. Music, Entertainment & Performing Arts
            new SpeakingTopicSet(
                    "Music, Live Performances & Entertainment Media",
                    new String[] {
                            "What genres of music do you find yourself listening to most frequently?",
                            "Can you play any musical instruments, or have you ever tried to learn one?",
                            "Do you prefer listening to recorded music at home or attending live concert performances?",
                            "Has your taste in music evolved significantly since you were a teenager?"
                    },
                    "Describe a song, piece of music, or live performance that holds a special significance for you. You should say: what piece of music it is, who created or performed it, when you first heard it, and explain why it evokes strong feelings or memories for you.",
                    new String[] {
                            "Why does music have such a profound universal ability to evoke emotions across different human cultures?",
                            "Has digital music streaming benefited or harmed independent artists and musicians financially?",
                            "Should primary and secondary schools continue to mandate formal music and performing arts education?",
                            "How has the convenience of on-demand digital entertainment affected traditional cinema and theater attendance?"
                    }
            ),

            // 16. Childhood, Education & Lifelong Learning
            new SpeakingTopicSet(
                    "Early Childhood, Educational Systems & Lifelong Development",
                    new String[] {
                            "What is one of your clearest and happiest memories from your early childhood?",
                            "Did you enjoy your primary school years, and do you remember your first teacher?",
                            "What subject did you find most exciting or rewarding when you were in school?",
                            "Do you believe that adults should continuously pursue new skills throughout their lives?"
                    },
                    "Describe an inspirational teacher or mentor who had a lasting influence on your academic or personal development. You should say: who this teacher was, what subject they taught you, what their teaching method was like, and explain how their guidance shaped your future.",
                    new String[] {
                            "How should modern school curriculums balance traditional academic examinations with creative and practical life skills?",
                            "Do you believe that standardized testing is an accurate measure of a student's true intellectual potential?",
                            "What are the key advantages and drawbacks of online remote learning compared to traditional physical classrooms?",
                            "How can societies support lifelong education for older adults who need to adapt to changing workplace technologies?"
                    }
            )
    );

    private ExamSpeakingTurnGenerator() {}

    /**
     * Generates a coherent, deterministic 9-turn plan for an IELTS Speaking simulation attempt.
     */
    public static SpeakingTurnPlan generatePlan(UUID formId, String logicalKey) {
        // 1. Reference Form Regression Anchor Check: Cambridge IELTS 14 Test 1
        boolean isReference = (formId != null && formId.toString().equalsIgnoreCase("ecc3704f-d512-5509-98dd-02444c328883"))
                || (logicalKey != null && logicalKey.toUpperCase().contains("VOL_14_TEST_01"));

        if (isReference) {
            String[] p1Media = new String[] {
                    "/storage/exams/examiner/examiner_p1_q1.mp4",
                    "/storage/exams/examiner/examiner_p1_q2.mp4",
                    "/storage/exams/examiner/examiner_p1_q3.mp4",
                    "/storage/exams/examiner/examiner_p1_q4.mp4"
            };
            String p2Media = "/storage/exams/examiner/examiner_p2_cue.mp4";
            String[] p3Media = new String[] {
                    "/storage/exams/examiner/examiner_p3_q1.mp4",
                    "/storage/exams/examiner/examiner_p3_q2.mp4",
                    "/storage/exams/examiner/examiner_p3_q3.mp4",
                    "/storage/exams/examiner/examiner_p3_q4.mp4"
            };

            return new SpeakingTurnPlan(
                    REFERENCE_TOPIC_SET.topicFamily(),
                    "GENERATED_SIMULATION_TURN",
                    REFERENCE_TOPIC_SET.part1Prompts(),
                    REFERENCE_TOPIC_SET.part2CuePrompt(),
                    REFERENCE_TOPIC_SET.part3Prompts(),
                    p1Media,
                    p2Media,
                    p3Media
            );
        }

        // 2. Deterministic Form-Specific Simulation Generation
        // Stable seed: hash(formId + "_speaking_v1")
        String seedKey = (formId != null ? formId.toString() : (logicalKey != null ? logicalKey : "default_seed")) + "_speaking_v1";
        int hash = computeStableHash(seedKey);
        int index = Math.abs(hash) % SIMULATION_TOPIC_SETS.size();

        SpeakingTopicSet selectedSet = SIMULATION_TOPIC_SETS.get(index);
        int topicNum = index + 1;
        String prefix = String.format("/storage/exams/examiner/generated/topic_%02d_", topicNum);
        String[] p1Media = new String[] {
                prefix + "p1_q1.mp3",
                prefix + "p1_q2.mp3",
                prefix + "p1_q3.mp3",
                prefix + "p1_q4.mp3"
        };
        String p2Media = prefix + "p2_cue.mp3";
        String[] p3Media = new String[] {
                prefix + "p3_q1.mp3",
                prefix + "p3_q2.mp3",
                prefix + "p3_q3.mp3",
                prefix + "p3_q4.mp3"
        };

        return new SpeakingTurnPlan(
                selectedSet.topicFamily(),
                "GENERATED_SIMULATION_TURN",
                selectedSet.part1Prompts(),
                selectedSet.part2CuePrompt(),
                selectedSet.part3Prompts(),
                p1Media,
                p2Media,
                p3Media
        );
    }

    private static int computeStableHash(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return ((digest[0] & 0xFF) << 24) |
                   ((digest[1] & 0xFF) << 16) |
                   ((digest[2] & 0xFF) << 8)  |
                   (digest[3] & 0xFF);
        } catch (Exception e) {
            return input.hashCode();
        }
    }
}
