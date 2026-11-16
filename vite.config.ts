
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Define a chave de API fornecida para uso global no aplicativo via process.env.API_KEY
  }
})
