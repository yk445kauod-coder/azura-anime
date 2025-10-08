import { useState } from 'react';
import { useSetRecoilState } from 'recoil';
import { secretChatAccessState } from '../atoms/secretChatAtom';
import { SECRET_CHAT_PASSWORD } from '../lib/constants';

export const SecretChatAuth = () => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const setSecretAccess = useSetRecoilState(secretChatAccessState);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (password === SECRET_CHAT_PASSWORD) {
      setError('');
      setSecretAccess(true);
      localStorage.setItem('secretChatAccess', 'true');
    } else {
      setError('Invalid password. Please try again.');
    }
  };

  return (
    <div className="max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-6 text-center text-gray-800">Secret Chat Access</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter secret code"
            className="w-full p-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}
        </div>
        <button 
          type="submit"
          className="w-full bg-blue-500 text-white py-3 rounded-md hover:bg-blue-600 transform transition-transform duration-200 hover:scale-105"
        >
          Access Secret Chat
        </button>
      </form>
    </div>
  );
};