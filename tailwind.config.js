/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F5F4F0',
        ink: '#080808',
        hawk: '#C8102E',
        quiet: '#6C6B67',
      },
      fontFamily: {
        sans: ['"Space Grotesk"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        serif: ['"DM Serif Display"', 'Georgia', 'serif'],
      },
      letterSpacing: {
        editorial: '-0.065em',
      },
    },
  },
  plugins: [],
}
