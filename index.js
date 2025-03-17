import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

// Check for the required environment variables
if (!ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required environment variables");
  process.exit(1);
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Initialize Twilio client
const twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio,
// including lead details (name, email, phone) as query parameters.
fastify.all("/incoming-call-eleven", async (request, reply) => {
  const { name, email, phone } = request.query;
  const params = new URLSearchParams();
  if (name) params.append("name", name);
  if (email) params.append("email", email);
  if (phone) params.append("phone", phone);
  const queryString = params.toString();

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Connect>
      <Stream url="wss://${request.headers.host}/media-stream${queryString ? "?" + queryString : ""}" />
    </Connect>
  </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("[Server] Twilio connected to media stream.");
    // Extract lead details from query parameters
    const { name, email, phone } = req.query;
    console.log("Lead details received:", { name, email, phone });

    let streamSid = null;

    // Build query parameters for ElevenLabs using the expected parameter names
    const elevenParams = new URLSearchParams({
      agent_id: ELEVENLABS_AGENT_ID,
      ...(name && { lead_name: name }),
      ...(email && { lead_email: email }),
      ...(phone && { lead_phone: phone })
    });

    // Connect to ElevenLabs Conversational AI WebSocket with lead details
    const elevenLabsWs = new WebSocket(
      `wss://api.elevenlabs.io/v1/convai/conversation?${elevenParams.toString()}`
    );

    elevenLabsWs.on("open", () => {
      console.log("[II] Connected to Conversational AI.");
    });

    elevenLabsWs.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        handleElevenLabsMessage(message, connection);
      } catch (error) {
        console.error("[II] Error parsing message:", error);
      }
    });

    elevenLabsWs.on("error", (error) => {
      console.error("[II] WebSocket error:", error);
    });

    elevenLabsWs.on("close", () => {
      console.log("[II] Disconnected.");
    });

    const handleElevenLabsMessage = (message, connection) => {
      switch (message.type) {
        case "conversation_initiation_metadata":
          console.info("[II] Received conversation initiation metadata.");
          break;
        case "audio":
          if (message.audio_event?.audio_base_64) {
            const audioData = {
              event: "media",
              streamSid,
              media: {
                payload: message.audio_event.audio_base_64,
              },
            };
            connection.send(JSON.stringify(audioData));
          }
          break;
        case "interruption":
          connection.send(JSON.stringify({ event: "clear", streamSid }));
          break;
        case "ping":
          if (message.ping_event?.event_id) {
            const pongResponse = {
              type: "pong",
              event_id: message.ping_event.event_id,
            };
            elevenLabsWs.send(JSON.stringify(pongResponse));
          }
          break;
      }
    };

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started with ID: ${streamSid}`);
            break;
          case "media":
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            elevenLabsWs.close();
            break;
          default:
            console.log(`[Twilio] Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    connection.on("close", () => {
      elevenLabsWs.close();
      console.log("[Twilio] Client disconnected");
    });

    connection.on("error", (error) => {
      console.error("[Twilio] WebSocket error:", error);
      elevenLabsWs.close();
    });
  });
});

// Route to initiate an outbound call with additional user information.
// The lead details are appended as query parameters to the webhook URL.
// The "to" field now serves as both the destination phone and the lead phone.
fastify.post("/make-outbound-call", async (request, reply) => {
  const { to, name, email } = request.body; // "to" is used as the phone number

  if (!to || !name || !email) {
    return reply.status(400).send({ error: "Destination phone number, name, and email are required" });
  }

  // Use the "to" field as the phone number for lead details.
  const phone = to;

  try {
    const callWebhookUrl = `https://${request.headers.host}/incoming-call-eleven?name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}`;
    
    const call = await twilioClient.calls.create({
      url: callWebhookUrl,
      to: to,
      from: TWILIO_PHONE_NUMBER,
    });

    console.log(`[Twilio] Outbound call initiated: ${call.sid} for ${name} (${email}, ${phone})`);
    reply.send({ message: "Call initiated", callSid: call.sid });
  } catch (error) {
    console.error("[Twilio] Error initiating call:", error);
    reply.status(500).send({ error: "Failed to initiate call" });
  }
});

// Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
