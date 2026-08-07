const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ---- GOOGLE OAUTH2 ----
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ---- HEALTH CHECK ----
app.get('/', (req, res) => {
  res.json({ message: 'DialPal Vapi Server is running' });
});

// ---- MAIN VAPI TOOL HANDLER ----
app.post('/vapi/tools', async (req, res) => {
  console.log('Raw body:', JSON.stringify(req.body, null, 2));

  const toolCall = req.body?.message?.toolCalls?.[0];

  if (!toolCall) {
    console.log('No tool call found');
    return res.status(200).json({
      results: [{ toolCallId: 'unknown', result: 'Received but could not parse tool call' }]
    });
  }

  const toolCallId = toolCall.id;
  const toolName = toolCall.function.name;
  const args = toolCall.function.arguments;
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;

  console.log(`Tool called: ${toolName}`, parsedArgs);

  try {
    if (toolName === 'cancel_appointment' || toolName === 'manageAppointment') {
      const result = await cancelAppointment(parsedArgs);
      return res.status(200).json({
        results: [{ toolCallId, result }]
      });
    }

    return res.status(200).json({
      results: [{ toolCallId, result: 'Unknown tool' }]
    });

  } catch (err) {
    console.error('Tool error:', err);
    return res.status(200).json({
      results: [{ toolCallId, result: `Error: ${err.message}` }]
    });
  }
});

// ---- CANCEL APPOINTMENT FUNCTION ----
async function cancelAppointment({ patientName, name, date, appointmentDate }) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const searchName = patientName || name;
  const searchDate = date || appointmentDate;

  if (!searchName || !searchDate) {
    return 'Missing patient name or date — cannot cancel.';
  }

  const startOfDay = new Date(searchDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(searchDate);
  endOfDay.setHours(23, 59, 59, 999);

  const response = await calendar.events.list({
    calendarId,
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  console.log(`Found ${events.length} events on ${searchDate}`);

  const match = events.find(e =>
    e.summary && e.summary.toLowerCase().includes(searchName.toLowerCase())
  );

  if (!match) {
    return JSON.stringify({
      status: 'not_found',
      message: `No matching appointment found for ${searchName} on ${searchDate}.`
    });
  }

  await calendar.events.delete({
    calendarId,
    eventId: match.id,
    sendUpdates: 'all'
  });

  return JSON.stringify({
    status: 'confirmed',
    eventId: match.id,
    message: `Appointment for ${searchName} on ${searchDate} has been successfully cancelled.`
  });
}

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});