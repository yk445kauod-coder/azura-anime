import { atom } from 'recoil';

export interface UserState {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL: string | null;
}

export const userState = atom<UserState | null>({
  key: 'userState',
  default: null,
});