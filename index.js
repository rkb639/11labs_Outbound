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

// Store lead details temporarily using callSid as the key
const callDetails = {};

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/incoming-call-eleven", async (request, reply) => {
  const callSid = request.query.CallSid; // Get the CallSid from the query parameters

  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream?callSid=${callSid}" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams from Twilio
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (connection, req) => {
    console.info("Twilio connected to media stream.");

    const url = new URL(req.url, `wss://${req.headers.host}`);
    const callSid = url.searchParams.get('callSid');
    const leadDetails = callDetails[callSid] || {};

    let streamSid = null;
    let elevenLabsWs; // Declare elevenLabsWs outside the onopen event

    // Function to handle ElevenLabs messages
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
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify(pongResponse));
            }
          }
          break;
      }
    };

    connection.on("open", () => {
      // Prepare agent state with lead details
      const agentState = {};
      
      // Only add properties that exist
      if (leadDetails.name) agentState.lead_name = leadDetails.name;
      if (leadDetails.email) agentState.lead_email = leadDetails.email;
      if (leadDetails.phone) agentState.lead_phone = leadDetails.phone;
      
      // Set custom query parameters for agent state
      const queryParams = new URLSearchParams();
      queryParams.append('agent_id', ELEVENLABS_AGENT_ID);
      
      // Add agent state as a query parameter if we have any details
      if (Object.keys(agentState).length > 0) {
        queryParams.append('agent_state', JSON.stringify(agentState));
      }
      
      // Connect to ElevenLabs Conversational AI WebSocket with agent state
      elevenLabsWs = new WebSocket(
        `wss://api.elevenlabs.io/v1/convai/conversation?${queryParams.toString()}`
      );

      elevenLabsWs.on("open", () => {
        console.log("[II] Connected to Conversational AI.");
        // Send a personalized greeting to ElevenLabs if lead name is available
        if (leadDetails.name) {
          const greeting = {
            text: `Hello, ${leadDetails.name}.`,
            is_final: true,
          };
          if (elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify(greeting));
          }
        }
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
        console.log("[II] Disconnected from ElevenLabs.");
      });
    });

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log(`Stream started with ID: ${streamSid}`);
            break;
          case "media":
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;
          case "stop":
            if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            delete callDetails[callSid]; // Clean up call details for this callSid
            break;
          default:
            console.log(`Received unhandled event: ${data.event}`);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    connection.on("close", () => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
      delete callDetails[callSid]; // Clean up call details for this callSid
      console.log("Client disconnected");
    });

    connection.on("error", (error) => {
      console.error("WebSocket error:", error);
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
      delete callDetails[callSid]; // Clean up call details for this callSid
    });
  });
});

// Route to initiate an outbound call
fastify.post("/make-outbound-call", async (request, reply) => {
  const { to, name, email, phone } = request.body; // Get all lead details

  if (!to) {
    return reply.status(400).send({ error: "Destination phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      url: `https://${request.headers.host}/incoming-call-eleven`, // Webhook for call handling
      to: to,
      from: TWILIO_PHONE_NUMBER,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'], // Optional: Monitor call status
      statusCallback: `https://${request.headers.host}/call-status`, // Optional: Webhook for status updates
    });

    console.log(`Outbound call initiated: ${call.sid}`);
    
    // Store all lead details using callSid
    callDetails[call.sid] = {
      name: name,
      email: email,
      phone: phone || to // Use the 'to' number as fallback if no specific phone is provided
    };
    
    reply.send({ 
      message: "Call initiated", 
      callSid: call.sid,
      leadDetails: callDetails[call.sid] 
    });
  } catch (error) {
    console.error("Error initiating call:", error);
    reply.status(500).send({ error: "Failed to initiate call" });
  }
});

// Optional: Route to handle call status updates from Twilio
fastify.post("/call-status", async (request, reply) => {
  console.log(request.body);
  reply.send({ message: "Call status received" });
});

// Start the Fastify server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`Listening on port ${PORT}`);
});
