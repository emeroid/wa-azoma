module.exports = {
    apps : [
      {
        name: "whatsapp-gateway",
        script: "./index.js",
        instances: 1,
        exec_mode: "fork",
      },
      {
        name: "whatsapp-worker",
        script: "./worker.js",
        instances: 2, // You can run 2 or more workers to process jobs faster
        exec_mode: "fork",
      }
    ]
  }