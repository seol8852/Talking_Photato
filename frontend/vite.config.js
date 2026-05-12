import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 기존에 있던 다른 설정들이 있다면 그대로 두시고,
  // 그 아래에 optimizeDeps 블록만 추가해 줍니다! 👇
  optimizeDeps: {
    include: ['prop-types', 'react-simple-maps']
  }
});