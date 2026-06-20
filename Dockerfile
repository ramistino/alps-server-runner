FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=10000

COPY package.json ./
RUN npm install --omit=dev

COPY runner.js ./

EXPOSE 10000
CMD ["npm", "start"]
