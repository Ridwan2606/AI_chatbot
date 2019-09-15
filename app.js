/*-----------------------------------------------------------------------------
A simple Language Understanding (LUIS) bot for the Microsoft Bot Framework. 
-----------------------------------------------------------------------------*/

var restify = require('restify');
var builder = require('botbuilder');
var botbuilder_azure = require("botbuilder-azure");
var request = require('request');
var mysql = require('mysql');
const CosmosClientInterface = require("@azure/cosmos").CosmosClient;
require('dotenv').config()

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
	console.log('%s listening to %s', server.name, server.url);
});
  
// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MicrosoftAppId,
    appPassword: process.env.MicrosoftAppPassword,
    openIdMetadata: process.env.BotOpenIdMetadata
});

// Listen for messages from users 
server.post('/api/messages', connector.listen());

/*----------------------------------------------------------------------------------------
* Bot Storage: This is a great spot to register the private state storage for your bot. 
* We provide adapters for Azure Table, CosmosDb, SQL Azure, or you can implement your own!
* For samples and documentation, see: https://github.com/Microsoft/BotBuilder-Azure
* ---------------------------------------------------------------------------------------- */

var tableName = 'botdata';
var azureTableClient = new botbuilder_azure.AzureTableClient(tableName, process.env['AzureWebJobsStorage']);
var tableStorage = new botbuilder_azure.AzureBotStorage({ gzipData: false }, azureTableClient);

// Create your bot with a function to receive messages from the user
// This default message handler is invoked if the user's utterance doesn't
// match any intents handled by other dialogs.
// var bot = new builder.UniversalBot(connector, function (session, args) {
//     session.send('You reached the default message handler. You said \'%s\'.', session.message.text);
// });
var bot = new builder.UniversalBot(connector, {
	localizerSettings: {
		defaultLocale: 'fr'
	}
});

bot.set('storage', tableStorage);

//MySQL Functions
function sqlConnect(){
	return mysql.createConnection({
		host : process.env.sqlhost,
		user: process.env.sqluser , 
		password: process.env.sqlpwd,
		database: process.env.sqldatabase, 
	});
}

function sqlQuery ( connection, queryString) {
	connection.connect();
    connection.query(queryString, (err,rows, fields) => 
    {
        if (err){
			console.log (err);
        } else {
            console.log ("SQL Database successfully updated");
		}
	})
	connection.end();
}


// This is the LUIS app credentials
var luisAppId = process.env.LuisAppId;
var luisAPIKey = process.env.LuisAPIKey;
var luisAPIHostName = process.env.LuisAPIHostName || 'westus.api.cognitive.microsoft.com';
const LuisModelUrl = 'https://' + luisAPIHostName + '/luis/v2.0/apps/' + luisAppId + '?subscription-key=' + luisAPIKey;

// This is the QNAMAKER app credentials
var QNAAppId = process.env.QNAID;
var QNAAPIKey = process.env.QNAKey;
var QNAAPIHostName = process.env.QNAHostname;
const qnaUrl = QNAAPIHostName + '/knowledgebases/' + QNAAppId + '/generateAnswer';

var boolNotFoundinLuis = false;
var boolHelp = false;


// Create a recognizer that gets intents from LUIS, and add it to the bot
var recognizer = new builder.LuisRecognizer(LuisModelUrl);
bot.recognizer(recognizer);
var boolNewReply = false;

var intents = new builder.IntentDialog({
	recognizers: [recognizer],
	intentThreshold: 0.5
}).onDefault([(session, args, next) => {	

	// Assign appropriate details of message in variables
	db_messageid = session.message.address.id;
	db_text = session.message.text;
	db_intent = args.intent;
	db_time = session.message.timestamp;
	db_channel = session.message.address.channelId;
	db_userid = session.message.address.user.id;
	db_username = session.message.address.user.name;
	
	// if the message is not a hidden feedback postback message, store in message in database
	if (!(session.message.text.includes("OuiFeedback")) && !(session.message.text.includes("NonFeedback")) ) {
		//Query string that will be run in the DMS
		queryString = 
		`INSERT INTO chatbotlog.message (conversationid,text, intent, timeinitiated, channel) VALUES ("${db_messageid}","${db_text}","${db_intent}","${db_time}","${db_channel}");`;
		console.log(queryString);
		//Run the SQL query string
		sqlQuery( sqlConnect(), queryString);

		//Query string that will be run in the DMS
		queryString=
		`INSERT INTO chatbotlog.user (userid,conversationid,username) VALUES ("${db_userid}","${db_messageid}","${db_username}");`
		console.log(queryString);
		//Run the SQL query string
		sqlQuery( sqlConnect(), queryString);
	}

    //if intent not identified, ask to reformulate question
    if (args.intent == null) {
		boolNotFoundinLuis = true;
		next();
		//session.send('Désolé je n\'ai pas compris. \nEst-ce que vous pouvez-vous svp reformuler votre question?');
	}else if (args.intent == "Help"){
        boolHelp = true;
        next();
	} else {
		console.log('intent : '+args.intent);
		request.post({
			url: qnaUrl,
			body: JSON.stringify({ question: args.intent }),
			headers: { "Content-Type": "application/json", "Authorization": "EndpointKey " + QNAAPIKey }
		},
			function (error, res) {
				if (error) console.log(error);
				else {
					//console.log(res);
					var result = JSON.parse(res.body);
					
					if (result.answers[0].answer != "Désolé je n'ai pas compris. Pouvez-vous reformuler votre phrase?"){
						session.send(result.answers[0].answer);
					}
					if (!result.answers[0].answer.includes('Désolé') && (args.intent != 'Salutation')){//dbh
							session.send(new builder.Message()
							.text('Êtes-vous satisfait de la réponse?')
							.addAttachment(new builder.HeroCard()
							.buttons([
								builder.CardAction.postBack(session, `OuiFeedback ${session.message.address.id}`, 'Oui'),
								builder.CardAction.postBack(session, `NonFeedback ${session.message.address.id}`, 'Non')
							])
							));
				}	else {
						next();
					}					
				}
			});
	}
	// FEEDBACK WATER FALL
}, (session, results) => {
	if(session.message.text.includes('OuiFeedback')){
		messageid = session.message.text.split(" ")[1];
		boolNotFoundinLuis = false;
		queryString = 
		`UPDATE chatbotlog.message SET feedback = 'Oui' WHERE conversationid = "${messageid}";`
		console.log(queryString);
		sqlQuery( sqlConnect(), queryString);
		session.endConversation('Super! Je reste disponible pour toute autre question.');
	}else if ((session.message.text.includes('NonFeedback')) || boolNotFoundinLuis == true) {
		messageid = session.message.text.split(" ")[1];
		boolNotFoundinLuis = false;
		queryString = 
		`UPDATE chatbotlog.message SET feedback = 'Non' WHERE conversationid = "${messageid}";`
		sqlQuery( sqlConnect(), queryString);
		session.endConversation('Je suis désolée, mais je continue à apprendre tous les jours.\nEn attendant, vous pouvez contacter notre équipe de support a l\'addresse suivante : onthego@rogerscapital.mu');
	}else if (boolHelp){
        boolHelp = false;
        session.send(new builder.Message()
            .address(session.address)
            .addAttachment(new builder.HeroCard()
            .text('Bonjour, je suis Emma de Rogers Capital. Je suis là pour répondre à vos questions sur nos offres Hire Purchase, Loans et Leasing. Voici les exemples de questions que vous pouvez me poser:')
            .buttons([
                builder.CardAction.imBack(null, 'Où est situé votre bureau ?', 'Où est situé votre bureau ? '),
                builder.CardAction.imBack(null, 'Après combien de jours un loan est approuvé ?', 'Après combien de jours un loan est approuvé ?')
            ])
        ));       
    }
 }]);

bot.dialog('/', intents);

/**
 * On convesation update is always called at the start of every session 
 * and is used to provide users with greetings 
 */
bot.on('conversationUpdate',(message) => {

	if (message.membersAdded) {
		message.membersAdded.forEach((identity) => {
			if (identity.id == message.address.bot.id && message.source != 'skypeforbusiness') {
				console.log(message);
				//var imageURL = "https://us.123rf.com/450wm/kakigori/kakigori1602/kakigori160200041/53255996-stock-vector-portrait-of-happy-smiling-latina-call-center-operator-woman-on-support-phone-with-headset-isolated-o.jpg?ver=6";
				//var imageURL = "https://virginiea442.blob.core.windows.net/images/Emma-02-02.jpg";
				//var imageURL = "https://virginiea442.blob.core.windows.net/images/Emma-04.PNG";
				var imageURL = "https://emmawebappa831.blob.core.windows.net/images/Emma-PP.png";
				bot.send(new builder.Message()
					.address(message.address)
					.addAttachment(new builder.HeroCard()
					.text('Bonjour, je suis **Emma** de Rogers Capital. Je suis là pour répondre à vos questions sur nos offres Hire Purchase, Loans et Leasing. Voici les exemples de questions que vous pouvez me poser:')
					.images([
                    	builder.CardImage.create(null, imageURL)
                	])
					.buttons([
                    	builder.CardAction.imBack(null, 'Où est situé votre bureau ?', 'Où est situé votre bureau ? '),
						builder.CardAction.imBack(null, 'Après combien de jours un loan est approuvé ?', 'Après combien de jours un loan est approuvé ?')
                	])
				));
			}
		});
	} else if (message.membersRemoved) {
        // See if bot was removed
        var botId = message.address.bot.id;
        for (var i = 0; i < message.membersRemoved.length; i++) {
            if (message.membersRemoved[i].id === botId) {
                // Say goodbye
                var reply = new builder.Message()
                        .address(message.address)
                        .text("Goodbye");
				bot.send(reply);
				console.log("CONVO CLOSED");
                break;
            }
        }
    }
});
