import dotenv from 'dotenv'
import fs from 'fs'
import http from 'http'
import { Octokit, App } from 'octokit'
import { createNodeMiddleware } from '@octokit/webhooks'
import axios from 'axios';
import nodemailer from 'nodemailer';

// Load environment variables from .env file
dotenv.config()
// Set configured values
const appId = process.env.APP_ID
const privateKeyPath = process.env.PRIVATE_KEY_PATH
const privateKey = fs.readFileSync(privateKeyPath, 'utf8')
const secret = process.env.WEBHOOK_SECRET
const enterpriseHostname = process.env.ENTERPRISE_HOSTNAME
const Email=process.env.EMAIL
const Mdp=process.env.MDP
const CeoMail=process.env.CEOEMAIL
const openAiKey= process.env.Open_AI_Key;
// Create an authenticated Octokit client authenticated as a GitHub App
const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret
  },
  ...(enterpriseHostname && {
    Octokit: Octokit.defaults({
      baseUrl: `https://${enterpriseHostname}/api/v3`
    })
  })
})

// Define date range
const startDate = new Date('2024-01-21');
const endDate = new Date('2024-01-23');

// Optional: Get & log the authenticated app's name
const { data } = await app.octokit.request('/app')

// Read more about custom logging: https://github.com/octokit/core.js#logging
app.octokit.log.debug(`Authenticated as '${data.name}'`)
//Log in to Open AI
const openAiHeaders = {
  'Authorization': `Bearer ${openAiKey}`,
  'Content-Type': 'application/json'
};

// Subscribe to the "pull_request.opened" webhook event
app.webhooks.on('pull_request.opened', async ({ octokit, payload }) => {
  console.log(`Received a pull request event for #${payload.pull_request.number}`)
  try {
    const response = await octokit.rest.pulls.list({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      state: 'closed',
      sort: 'updated',
      direction: 'desc'
    });
    const mergedPRs = response.data.filter(pr => {
      const mergedAt = new Date(pr.merged_at);
      return pr.merged_at && mergedAt >= startDate && mergedAt <= endDate;
    });

    let changesString = "";
    
    for (const pr of mergedPRs) {
      const prNumber = pr.number;
      changesString += `---> Pull Request #${prNumber}:\n`;

      const commitsResponse = await octokit.rest.pulls.listCommits({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        pull_number: prNumber,
      });

      for (const commit of commitsResponse.data) {
        const commitDetailsResponse = await octokit.rest.repos.getCommit({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          ref: commit.sha,
        });

        for (const file of commitDetailsResponse.data.files) {
          changesString += `--> File modified: ${file.filename}:\n`;
          changesString += `-> Code modified in ${file.filename}:\n`;

          const patchLines = file.patch.split('\n');
          for (const line of patchLines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
              changesString += `+ ${line.substring(1)}\n`;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              changesString += `- ${line.substring(1)}\n`;
            }
          }
        }
      }
    }
    //console.log(changesString)
    const fullPrompt = `You will receive a text containing the following information: 
1. Pull Requests merged during a defined period, identified by "---> Pull Request #X:".
2. The names of the files modified in each Pull Request, mentioned as "--> File modified: [File name].".
3. The specific modifications made to each file, presented as "-> Code modified in [File name]".

Your main task is to write a final report for the non-technical team leader that will be sent as an email and should contain the following information:
1. Begins with an informal greeting, such as "Hello," and ends with "Sincerely, Your Virtual Assistant."
2. Summarizes the impacts of the changes made in the merged Pull Requests, using clear, non-technical language, without including code snippets, technical terms, or specific technical details.
3. Explains the significance of the changes in terms of functional, aesthetic, usability, or performance improvements, emphasizing their relevance to the overall project.
4. Avoid technical specifications and focus on the essence of the changes and their impact on the project.
5. Mention if key information for understanding the overall impact of the changes is missing or ambiguous, while remaining concise and to the point.

The final result should be a well-structured email because it will be sent automatically, so pay attention.
If the text you are getting is empty that mean there was no merged pull requests in that period of time , in this case write an email that notify the user that there was no changes in that period of time.


Important note: The report should be understandable to a non-technical audience, focusing on the progress and impact of the changes on the project without dwelling on technical details.

text: ${changesString}`;

    const openAiPayload = {
      prompt: fullPrompt,
      max_tokens: 500 // Adjust as needed
    };
    axios.post('https://api.openai.com/v1/engines/gpt-3.5-turbo-instruct/completions', openAiPayload, { headers: openAiHeaders })
    .then(async openAiResponse => {
      const summary = await openAiResponse.data.choices[0].text;
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: Email, 
          pass: Mdp
        }
      });
    
      // Email options
      let mailOptions = {
        from: Email,
        to: CeoMail,
        subject: 'CEO Assistant Report',
        text: summary
      };
    
      // Send the email
      try {
        let emailResponse = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + emailResponse.messageId);
      } catch (emailError) {
        console.error('Error sending email:', emailError);
      }
    })
    .catch(error => {
      console.error(`Error in ChatGPT API call: ${error}`);
    });

  } catch (error) {
    if (error.response) {
      console.error(`Error! Status: ${error.response.status}. Message: ${error.response.data.message}`)
    } else {
      console.error(error)
    }
  }
})

// Optional: Handle errors
app.webhooks.onError((error) => {
  if (error.name === 'AggregateError') {
    // Log Secret verification errors
    console.log(`Error processing request: ${error.event}`)
  } else {
    console.log(error)
  }
})

// Launch a web server to listen for GitHub webhooks
const port = process.env.PORT || 3000
const path = '/api/webhook'
const localWebhookUrl = `http://localhost:${port}${path}`

// See https://github.com/octokit/webhooks.js/#createnodemiddleware for all options
const middleware = createNodeMiddleware(app.webhooks, { path })

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`)
  console.log('Press Ctrl + C to quit.')
})
