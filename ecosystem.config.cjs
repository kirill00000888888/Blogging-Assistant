module.exports = {
  apps: [
    {
      name: "blog-bot-web",
      script: "server.js",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "blog-bot-telegram",
      script: "telegram-bot.js",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
