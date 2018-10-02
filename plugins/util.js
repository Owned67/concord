let client = null
const Discord = require( 'discord.js' )

const commands = require( '../commands.js' )
const permissions = require( '../permissions.js' )
const settings = require( '../settings.js' )
const _ = require( '../helper.js' )

const moment = require( 'moment' )
require( 'moment-duration-format' )

const fetch = require( 'node-fetch' )

const notices = require( './notices.js' )

let reminders = {}
let remindersDirty = false
const reminderDelay = 5 * 1000

function sendReminder( channel, user, rem, uid )
{
	channel.send( _.fmt( '**<@%s> [reminder]** `%s`', user.id, rem.message ) )
	delete reminders[uid]
	remindersDirty = true
}

function updateReminders()
{
	let needsSave = false
	if ( remindersDirty )
	{
		remindersDirty = false
		needsSave = true
	}
	
	for ( const uid in reminders )
	{
		if ( _.time() > reminders[uid].time )
		{
			const rem = reminders[uid]
			const user = client.users.get( rem.creator )
			
			if ( user )
				if ( rem.private )
					user.createDM().then( dm => sendReminder( dm, user, rem, uid ) )
				else
				{
					const chan = client.channels.get( rem.channel )
					if ( chan )
						sendReminder( chan, user, rem, uid )
				}
		}
	}
	
	if ( needsSave )
		settings.save( 'reminders', reminders )
	
	setTimeout( updateReminders, reminderDelay )
}

commands.register( {
	category: 'util',
	aliases: [ 'remind', 'remindme', 'reminder' ],
	help: 'set a timely reminder',
	args: '[time] [message]',
	callback: ( client, msg, args ) =>
	{
		const prefix = settings.get( 'config', 'command_prefix', '!' )
		if ( msg.author.id in reminders )
		{
			if ( args === 'cancel' )
			{
				delete reminders[msg.author.id]
				msg.channel.send( 'Reminder has been cancelled.' )
				remindersDirty = true
				return
			}
			else
				return msg.channel.send( _.fmt( 'Reminder pending in %s, use `%sreminder cancel` to cancel.', moment.duration( (_.time() - reminders[msg.author.id].time) * 1000 ).humanize(), prefix ) )
		}
		else if ( !args )
			return msg.channel.send( 'I current do not have any reminders set for you.' )
		
		args = _.sanesplit( args, ' ', 1 )
		if ( args.length < 2 )
			return msg.channel.send( '`' + commands.generateHelp( commands.getCMD( 'reminder' ) ) + '`' )
		
		const rem = {}
		rem.time = _.time() + _.parsetime( args[0] )
		rem.creator = msg.author.id
		rem.message = args[1]
		rem.private = msg.channel.type === 'dm'
		rem.channel = msg.channel.id
		
		reminders[msg.author.id] = rem
		msg.channel.send( _.fmt( 'I will remind you in %s', moment.duration( (_.time() - rem.time) * 1000 ).humanize() ) )
		remindersDirty = true
	} })

commands.register( {
	category: 'util',
	aliases: [ 'migrate' ],
	help: 'move everyone in your channel to another one',
	args: 'channel',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const channel = _.getVoiceChannel( client, msg.member )
		if ( !channel )
			return msg.channel.send( 'you are not in a voice channel' )
		
		const target = commands.findVoiceChannel( msg, args )
		if ( target === false )
			return
		
		const names = []
		channel.members.forEach( member =>
			{
				if ( member.user.presence.status === 'offline' ) return
				names.push( '`' + _.nick( member, channel.guild ) + '`' )
				notices.suppressNotice( channel.guild.id, 'voiceStateUpdate', member.id )
				member.setVoiceChannel( target )
			})
		
		notices.sendGuildNotice( channel.guild.id, _.fmt( '%s moved to `%s` by `%s`', names.join( ', ' ), target.name, _.nick( msg.member, channel.guild ) ) )
	} })

commands.register( {
	category: 'util',
	aliases: [ 'moveme' ],
	help: 'move yourself to another voice channel',
	args: 'channel',
	flags: [ 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const channel = _.getVoiceChannel( client, msg.member )
		if ( !channel )
			return msg.channel.send( 'you are not in a voice channel' )
		
		const target = commands.findVoiceChannel( msg, args )
		if ( target === false )
			return
		
		if ( !target.permissionsFor( msg.member ).has( Discord.Permissions.FLAGS.CONNECT ) )
			return msg.channel.send( 'you do not have permission to join that channel' )

		msg.member.setVoiceChannel( target )
	} })

module.exports.setup = _cl => {
    client = _cl

    reminders = settings.get( 'reminders', null, {} )
    updateReminders()

    _.log( 'loaded plugin: util' )
}
