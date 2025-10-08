import { useState } from 'react';
import { useSetRecoilState } from 'recoil';
import { secretChatAccessState } from '../atoms/secretChatAtom';
import { SECRET_CHAT_PASSWORD } from '../lib/constants';

export const SecretChatAuth = () => {
  const [password, setPassword] = useState('');
  const setSecretAccess = useSetRecoilState(secretChatAccessState);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === SECRET_CHAT_PASSWORD) {
      setSecretAccess(true);
      localStorage.setItem('secretChatAccess', 'true');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Enter secret code"
        className="w-full p-2 border rounded-md"
      />
      <button 
        type="submit"
        className="w-full bg-blue-500 text-white py-2 rounded-md hover:bg-blue-600"
      >
        Access Secret Chat
      </button>
    </form>
  );
};