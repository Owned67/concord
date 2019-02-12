const util = require( 'util' )
const moment = require( 'moment' )

const _ = {}
_.jstr = JSON.stringify
_.exec = str => require('child_process').execSync( str )
_.fmt = util.format
_.isjson = str => { try { JSON.parse( str ); return true } catch (e) { return false } }
_.time = () => Math.floor( Date.now() / 1000 )
_.pad = (num, size) => {
    let s = num.toString()
    while ( s.length < size )
        s = '0' + s
    return s
}
_.rand = (min, max) => Math.floor( ( Math.random() * max ) + min )
_.round = (num, places) => {
    num = parseFloat( num )
    places = places || 0
    return Number( Math.round( num + 'e' + places ) + 'e-' + places )
}
_.sanesplit = (str, del, limit) => {
    const arr = str.split( del )
    const res = arr.splice( 0, limit )
    res.push( arr.join( del ) )
    return res
}
_.matches = (reg, str) => {
    let matches
    const output = []
    while ( (matches = reg.exec( str )) !== null )
        output.push( matches[1] )
    return output
}
_.wrap = (array, delim, perline) => {
    const regex = new RegExp( `((?:[^, ]*, ){${perline}})`, 'g' )
    return array.join( delim ).replace( regex, '$1\n' )
}
_.parsetime = str => {
    str = str.replace( / /g, '' )
    
    str = str.replace( /min/g, 'm' )
    str = str.replace( /mins/g, 'm' )
    str = str.replace( /minute/g, 'm' )
    str = str.replace( /minutes/g, 'm' )
    
    str = str.replace( /hr/g, 'h' )
    str = str.replace( /hrs/g, 'h' )
    str = str.replace( /hour/g, 'h' )
    str = str.replace( /hours/g, 'h' )
    
    str = str.replace( /sec/g, 's' )
    str = str.replace( /secs/g, 's' )
    str = str.replace( /second/g, 's' )
    str = str.replace( /seconds/g, 's' )
    
    str = str.replace( /(\d+):(\d+):(\d+)/g, '$1h$2m$3s' )
    str = str.replace( /(\d+):(\d+)/g, '$1m$2s' )
    
    let time = 0
    if ( str.match( /(\d+)d/g ) )
        time += parseInt( _.matches( /(\d+)d/g, str )[0] ) * 60 * 60 * 24
    if ( str.match( /(\d+)h/g ) )
        time += parseInt( _.matches( /(\d+)h/g, str )[0] ) * 60 * 60
    if ( str.match( /(\d+)m/g ) )
        time += parseInt( _.matches( /(\d+)m/g, str )[0] ) * 60
    if ( str.match( /(\d+)s/g ) )
        time += parseInt( _.matches( /(\d+)s/g, str )[0] )
    
    if ( time === 0 && str.length !== 0 )
        time = parseInt( str )
    
    return time
}
_.filterlinks = str => {
    str = str.toString()
    const link_regex = /(\bhttps?:\/\/[^\s]+)/g
    if ( str.match( link_regex ) )
    {
        const link = _.matches( link_regex, str )[0]
        if ( !link.endsWith( '>' ) ) // if it ends with a > it's already been filtered
            str = str.replace( link_regex, '<' + link + '>' )
    }
    return str
}
_.log = (...args) => {
    let str = ''
    for ( let i = 0; i < args.length; i++ )
        str += args[i].toString() + ' '
    str = str.substring( 0, str.length - 1 )
    console.log( _.fmt( '[%s]  %s', moment().format( 'YYYY-MM-DD hh:mm:ss' ), str ) )
}
_.nick = ( user, guild ) => {
	if ( guild )
	{
		let member = user
		if ( !member.user )
			member = guild.members.get( member.id )
		if ( member )
		{
			if ( member.nickname )
				return member.nickname
			return member.user.username
		}
	}
    return user.username
}
_.shuffleArr = arr => {
		let curr = arr.length
		let temp = false
		let rand = 0
	  
		while ( curr !== 0 )
		{
		  rand = Math.floor( Math.random() * curr )
		  curr--
	  
		  temp = arr[ curr ]
		  arr[ curr ] = arr[ rand ]
		  arr[ rand ] = temp
		}
	  
		return arr
	}
_.logEvent = ( cl, type, e ) =>
	{
		let tag = '?'
		if ( cl && cl.user && cl.user.tag )
			tag = cl.user.tag
		return _.log( `<${ tag }> ${ type } ${ JSON.stringify( e ) || '' }` )
	}
_.logError = ( cl, e ) =>
	{
		_.log( `<${ cl.user.tag }> error` )
		console.error( e.error || e )
	}

_.getVoiceChannel = ( bot, member ) =>
	{
		if ( !member.voice || !member.voice.channelID )
			return false

		return bot.channels.get( member.voice.channelID )
	}

module.exports = _
