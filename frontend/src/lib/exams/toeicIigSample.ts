/**
 * Self-authored TOEIC-format sample for the DEVELOPMENT-ONLY preview of the IIG-style room (`/toeic-iig-preview`).
 * Every sentence, passage and figure here was written for English Coach; nothing is copied from ETS, IIG or any test
 * book. Never imported into the exam bank. Printed question numbers follow the TOEIC ranges so the room can be
 * compared with the reference; the sample has fewer items than a real form.
 */
import type { PublicManifestDto, PublicGroupDto, PublicItemDto } from '@/types/exams';

const opt = (texts: string[]) => texts.map((text, i) => ({ id: 'ABCD'[i], text }));

function item(n: number, prompt: string, options: Array<{ id: string; text: string }>): PublicItemDto {
  return {
    id: `s-item-${n}`,
    placementId: `s-pl-${n}`,
    prompt,
    interactionType: 'SINGLE_CHOICE',
    optionDefinitions: { questionNumber: n, options },
    cardinality: 1,
  };
}

function group(id: string, skill: string, items: PublicItemDto[], stimuli: PublicGroupDto['stimuli'], instructions?: string[]): PublicGroupDto {
  return { id, questionType: 'MULTIPLE_CHOICE', skill, stimuli, items, presentation: instructions ? { instructions } : null };
}

const audio = (id: string) => ({ id: `st-${id}`, kind: 'AUDIO', title: '', bodyPayload: {}, assets: [{ assetId: id, role: 'PRIMARY', mimeType: 'audio/wav', delivery: 'PLAYBACK_GRANT' }] });
const image = (id: string, title = '') => ({ id: `st-${id}`, kind: 'IMAGE', title, bodyPayload: {}, assets: [{ assetId: id, role: 'FIGURE', mimeType: 'image/svg+xml', delivery: 'PLAYBACK_GRANT' }] });
const text = (id: string, body: Record<string, any>, kind = 'TEXT', title = '') => ({ id: `st-${id}`, kind, title, bodyPayload: body, assets: [] });

export const TOEIC_IIG_SAMPLE: PublicManifestDto = {
  formId: 'toeic-iig-sample',
  title: 'English Coach TOEIC sample (self-authored)',
  family: 'TOEIC',
  variant: 'STANDARD_FIXED_FORM',
  scope: 'FULL',
  manifestHash: 'sample',
  sections: [
    {
      id: 'sample-listening',
      skill: 'LISTENING',
      ordinal: 1,
      durationSeconds: 2700,
      parts: [
        {
          id: 'p1', partCode: 'LISTENING_PART_1', ordinal: 1,
          instructions: 'Select the one statement that best describes what you see in the picture.',
          groups: [
            group('g1', 'LISTENING', [item(1, '', opt(['', '', '', '']))], [audio('sample-audio-1'), image('sample-photo-1')]),
            group('g2', 'LISTENING', [item(2, '', opt(['', '', '', '']))], [image('sample-photo-2')]),
          ],
        },
        {
          id: 'p2', partCode: 'LISTENING_PART_2', ordinal: 2,
          instructions: 'Select the best response to the question or statement.',
          groups: [
            group('g7', 'LISTENING', [item(7, '', opt(['', '', '']))], [audio('sample-audio-2')]),
            group('g8', 'LISTENING', [item(8, '', opt(['', '', '']))], []),
            group('g9', 'LISTENING', [item(9, '', opt(['', '', '']))], []),
          ],
        },
        {
          id: 'p3', partCode: 'LISTENING_PART_3', ordinal: 3,
          instructions: 'Select the best answer to each question about the conversation.',
          groups: [
            group(
              'g32',
              'LISTENING',
              [
                item(32, 'Where most likely are the speakers?', opt(['At a train station', 'At a hardware store', 'At a community library', 'At a print shop'])),
                item(33, 'What does the woman ask about?', opt(['A delivery date', 'A membership card', 'A room booking', 'A late fee'])),
                item(34, 'Look at the graphic. Which room will the man use?', opt(['Room 1', 'Room 2', 'Room 3', 'Room 4'])),
              ],
              [audio('sample-audio-3'), image('sample-table-1', 'Study rooms')]
            ),
          ],
        },
        {
          id: 'p4', partCode: 'LISTENING_PART_4', ordinal: 4,
          instructions: 'Select the best answer to each question about the talk.',
          groups: [
            group(
              'g71',
              'LISTENING',
              [
                item(71, 'Who is the speaker addressing?', opt(['New volunteers', 'Hotel guests', 'Sales managers', 'Bus drivers'])),
                item(72, 'Look at the graphic. In which month did the event attract the most visitors?', opt(['March', 'April', 'May', 'June'])),
                item(73, 'What are the listeners asked to do next?', opt(['Collect a name badge', 'Fill in a survey', 'Watch a short video', 'Choose a work shift'])),
              ],
              [audio('sample-audio-4'), image('sample-chart-1', 'Monthly visitors')]
            ),
          ],
        },
      ],
    },
    {
      id: 'sample-reading',
      skill: 'READING',
      ordinal: 2,
      durationSeconds: 4500,
      parts: [
        {
          id: 'p5', partCode: 'READING_PART_5', ordinal: 5,
          instructions: 'Select the best answer to complete the sentence.',
          groups: [
            group('g101', 'READING', [item(101, 'Ms. Osei asked the team to ------- the revised budget before Friday.', opt(['review', 'reviewing', 'reviewer', 'reviewed']))], []),
            group('g102', 'READING', [item(102, 'The new reading room is open to all residents, ------- they have a library card.', opt(['whether', 'provided that', 'in spite of', 'instead']))], []),
            group('g103', 'READING', [item(103, 'Because of the heavy rain, the outdoor concert was moved ------- the community hall.', opt(['to', 'at', 'by', 'over']))], []),
          ],
        },
        {
          id: 'p6', partCode: 'READING_PART_6', ordinal: 6,
          instructions: 'Select the best answer to complete the text.',
          groups: [
            group(
              'g131',
              'READING',
              [
                item(131, '', opt(['arrive', 'arrives', 'arriving', 'arrived'])),
                item(132, '', opt(['However', 'For example', 'As a result', 'Meanwhile'])),
                item(133, '', opt([
                  'Please bring a reusable bottle for the water stations.',
                  'Tickets for the evening film are already sold out.',
                  'Our office will be closed for repairs next week.',
                  'The river has flooded twice since the bridge opened.',
                ])),
                item(134, '', opt(['careful', 'carefully', 'care', 'cared'])),
              ],
              [
                text('notice-1', {
                  text:
                    'Riverside Clean-Up Day\n\nVolunteers who ---[131]--- before 8:30 A.M. will receive a free breakfast from the Harbor Café. ---[132]---, latecomers are still welcome and can join any team at the main tent.\n\nGloves, bags and grabbers will be provided. ---[133]--- Team leaders will explain how to sort the collected items ---[134]--- so that as much as possible can be recycled.',
                }),
              ]
            ),
          ],
        },
        {
          id: 'p7', partCode: 'READING_PART_7', ordinal: 7,
          instructions: 'Select the best answer for each question.',
          groups: [
            group(
              'g147',
              'READING',
              [
                item(147, 'What is the purpose of the notice?', opt(['To announce a schedule change', 'To recruit new staff', 'To describe a new product', 'To thank customers'])),
                item(148, 'When will the shuttle bus service resume?', opt(['On Monday', 'On Wednesday', 'On Friday', 'On Sunday'])),
              ],
              [
                text('notice-2', {
                  text:
                    'Lakeside Business Park — Shuttle Notice\n\nBecause the north entrance is being resurfaced, the morning shuttle bus will not run from Monday to Wednesday this week. Tenants may park in Lot C at no charge during this time.\n\nRegular shuttle service will resume on Friday. We apologize for any inconvenience.',
                }),
              ]
            ),
            group(
              'g196',
              'READING',
              [
                item(196, 'What does the web page indicate about the Alder desk?', opt(['It is available in two sizes', 'It is sold only online', 'It includes free assembly', 'It has a five-year warranty'])),
                item(197, 'Why did Ms. Varga write the e-mail?', opt(['To cancel an order', 'To ask about a measurement', 'To request a catalog', 'To report a damaged item'])),
                item(198, 'In the e-mail, the word "fit" in paragraph 1, line 2, is closest in meaning to', opt(['suit', 'exercise', 'fasten', 'repair'])),
                item(199, 'What is suggested about Ms. Varga?', opt(['She works from home', 'She owns a furniture shop', 'She ordered a desk last year', 'She lives near the showroom'])),
                item(200, 'What will Mr. Lind most likely send Ms. Varga?', opt(['A discount code', 'A drawing with dimensions', 'A replacement drawer', 'A delivery schedule'])),
              ],
              [
                text(
                  'set-196',
                  {
                    documentBoundaries: 'SEGMENTED',
                    documents: [
                      { declaredType: 'Web page', paragraphs: ['Northwood Furniture — Alder Desk', 'Solid oak top. Available in standard (120 cm) and compact (95 cm) widths. Flat-packed; assembly takes about 30 minutes.'] },
                      { declaredType: 'E-mail', paragraphs: ['To: Customer Service', 'From: Ana Varga', 'I would like to order the compact Alder desk for my home office, but I am not sure it will fit under the window. Could you tell me its exact height, including the drawer?'] },
                      { declaredType: 'E-mail', paragraphs: ['To: Ana Varga', 'From: Peter Lind, Northwood Furniture', 'Thank you for your question. I will send you a drawing that shows every dimension of the compact model today.'] },
                    ],
                  },
                  'MULTI_DOC'
                ),
              ]
            ),
          ],
        },
      ],
    },
  ],
};
