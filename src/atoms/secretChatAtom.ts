import { atom } from 'recoil';

export const secretChatAccessState = atom({
  key: 'secretChatAccessState',
  default: false,
});