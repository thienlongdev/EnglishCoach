export type EmbodiedAction = 'inspect' | 'wave' | 'clap' | 'cheer' | 'listen' | 'dance' | 'jump' | 'grab';
export const embodiedKeys: Partial<Record<string, EmbodiedAction>> = {
  Digit1: 'wave', Digit2: 'clap', Digit3: 'cheer', Digit4: 'listen', Digit5: 'dance', KeyH: 'inspect', Space: 'jump', KeyG: 'grab',
};
export const embodiedLabels: [EmbodiedAction, string, string, string][] = [
  ['inspect', 'H', 'Nhìn bàn tay', 'Look at hands'], ['wave', '1', 'Vẫy chào', 'Wave'],
  ['clap', '2', 'Vỗ tay', 'Clap'], ['cheer', '3', 'Vui mừng', 'Celebrate'],
  ['listen', '4', 'Lắng nghe', 'Listen'], ['dance', '5', 'Nhún nhảy', 'Dance'], ['jump', 'Space', 'Nhảy', 'Jump'],
];
