"use strict";

var util = require('util'),
	fs = require('fs'),
	path = require('path'),
	kd = require('kdtree.js'),
	stack = require('./tv/stack.js');

// weighted scoring for each car
var weightCars = {
	'UF1': 0,
	'XFG': 5,
	'XRG': 5,
	'XRT': 10,
	'RB4': 10,
	'FXO': 10,
	'LX4': 10,
	'LX6': 15,
	'MRT': 15,
	'FZ5': 15,
	'XFR': 20,
	'UFR': 18,
	'FOX': 20,
	'FO8': 25,
	'BF1': 45,
	'FXR': 30,
	'XRR': 30,
	'FZR': 30
};

var queue = function()
{
	var self = this;
	self.q = new stack();
	self.named = {};

	self.hasNamed = function(name)
	{
		return (self.named[name] !== undefined);
	}

	self.bottom = function()
	{
		return self.q.bottom();
	}

	self.top = function()
	{
		return self.q.top();
	};

	self.push = function(plid, priority, expires, named)
	{
		var id = self.q.push(plid, priority, expires);
		if (named)
		{
			self.named[named] = id;
			return named;
		}

		return id;
	};
	
	self.pop = function(id)
	{
		if (id && self.named[id])
			id = self.named[id];
		return self.q.pop(id);
	};
}
			
var tvDirector = function()
{
	var self = this;

	self.queue = new queue;

	// an array of plyrs, and their score
	self.plyrs = [];

	self.logger = null;
	self.client = null;
	self.insim = null;
	self.timers = {};
	self.history = {
		'current': null,
		'previous': null,
	};

	self.cooldown = 5000;

	self.init = function()
	{
		this.client.isiFlags |= this.insim.ISF_MCI | this.insim.ISF_CON | this.insim.ISF_HLV | this.insim.ISF_LOCAL;

		this.log.info('Registering TV2');

		self.logger = this.log;
		self.client = this.client;
		self.insim = this.insim;

		self.track = null;

		this.client.on('state:best', self.onFastest);
		this.client.on('state:track', self.onTrack);
		this.client.on('state:race', self.onStart);
		this.client.on('IS_LAP', self.onLap);
		this.client.on('IS_PLA', self.onPitLane);
		this.client.on('IS_CON', self.onContact);
		this.client.on('IS_FLG', self.onFlag);
		this.client.on('IS_HLV', self.onInvalidLap);
		this.client.on('IS_FIN', self.onFinish);
		this.client.on('IS_RES', self.onFinalStanding);

		this.client.on('connect', self.onConnect);
		this.client.on('disconnect', self.onDisconnect);
	}
	
	self.term = function()
	{
		if (self.timer)
			clearTimeout(self.timer);
	}

	self.log = function(text)
	{
		if (!self.logger)
			return;

		self.logger.info('TV:' + text);
	}

	self.nextViewpoint = function()
	{
		return self.queue.top();
	}

	self.onConnect = function()
	{
		self.timers.next = setInterval(function()
		{
			var d = self.nextViewpoint();
			if (d.plid <= 0)
				return;

			if (d.plid == self.history.current)
				return;

			self.history.current = d.plid;

			self.log('Changing to ' + d.plid + ' for ' + d.reason);

			self.change(d.plid);
		}, 500);

		self.timers.hunt = setInterval(function() {
			self.hunt();
		}, 5000);
	}

	self.onDisconnect = function()
	{
		clearTimeout(self.timers.next);
		clearTimeout(self.timers.hunt);
	}

	self.onFastest = function()
	{
		var lap = this.client.state.lap;
		var plid = this.client.state.best.plid;

		// we dont care about the fastest laps on lap 1
		if (lap <= 1 || plid <= 0)
			return;

		self.queue.push({'plid': plid, 'reason': 'new fastest'}, 100, 5);
	}

	self.onTrack = function()
	{
		var track = this.client.state.track;
		if (this.client.state.lname.length > 0)
			track = this.client.state.lname;

		if (track == 'FE2X')
			track = 'F25';

		if (track == 'FE3X')
			track = 'F33';

		if (track == 'AS1X')
			track = 'A11';

		self.track = new kd.KDTree(3);

		console.log('loading pth %s', track);

		var filename = path.join(__dirname, '/../data/pth', track + '.json');
		var pth = JSON.parse(fs.readFileSync(filename, 'utf8'));

		console.log('translating');
		var translated = [];
		for (var i = 0; i < pth.nodes.length; i++)
			translated.push([pth.nodes[i].x, pth.nodes[i].y, pth.nodes[i].z]);

		var start = new Date().getTime();
		console.log('building');
		self.track.build(translated);
		var end = new Date().getTime();
		console.log('building done in %d seconds', (end - start)/1000);

		self.hunt();
	}

	self.onPitLane = function(pkt)
	{
		if (self.isCurrent(pkt.plid))
			return;

		if (pkt.fact == self.insim.PITLANE_DT)
		{
			self.queue.push({ plid: pkt.plid, reason: 'Serving drive through' }, 100, 5);
			return;
		}

		if (pkt.fact == self.insim.PITLANE_SG)
		{
			self.queue.push({ plid: pkt.plid, reason: 'Serving drive through' }, 90, 5);
			return;
		}
	}

	self.onContact = function(pkt)
	{
		if (self.isCurrent(pkt.a.plid) || self.isCurrent(pkt.b.plid))
			return;

		var plid = pkt.a.plid;
		// focus on whoever most likely the cause
		// TODO this is a bit simple	
		if (pkt.b.speed > pkt.a.speed)
			plid = pkt.b.plid;

		if (self.client.state.plyrs[plid].finished)
			return;

		var plyra = this.client.state.getPlyrByPlid(pkt.a.plid);
		var plyrb = this.client.state.getPlyrByPlid(pkt.b.plid);
		self.queue.push({ 'plid': plid, reason: 'Contact - between' + plyra.pname + ' and ' + plyrb.pname }, 50, 10);
	}

	self.onFlag = function(pkt)
	{
		if (self.isCurrent(pkt.plid))
			return;

		if (!pkt.offon)
			return;

		switch(pkt.flag)
		{
			case self.insim.FLG_BLUE:
				self.log('Blue flag');
				var carbehind = this.client.state.getPlyrByPlid(pkt.carbehind);
				var carinfront = this.client.state.getPlyrByPlid(pkt.plid);
				if (carbehind.speed > carinfront.speed)
					self.queue.push({ plid: pkt.carbehind, reason: 'Blue flag, going to overtaker as they are faster'}, 200, 5);
				break;
			case self.insim.FLG_YELLOW:
				self.queue.push({ plid: pkt.plid, reason: 'Yellow flag, going to victim' }, 250, 5);
				break;
		}
	}

	self.onInvalidLap = function(pkt)
	{
		if (self.isCurrent(pkt.plid) || (self.client.state.plyrs[pkt.plid] && self.client.state.plyrs[pkt.plid].finished))
			return;

		switch(pkt.hlvc)
		{
			case self.insim.HLVC_SPEED:
				self.log('HLVC:Speeding');
				self.queue.push({ plid: pkt.plid, reason: 'HLVC: speeding' }, 500, 5);
				return;
				break;
			case self.insim.HLVC_WALL:
				self.log('HLVC:Wall');
				self.queue.push({ plid: pkt.plid, reason: 'HLVC: wall' }, 200, 5);
				return;
				break;
			case self.insim.HLVC_GROUND:
			default:
				return;
				break;
		}
	}

	self.onStart = function()
	{
		var i = 0;
		var plyrs = self.client.state.plyrs;

		while (i < plyrs.length)
		{
			if (plyrs[i].position == 1)
				break;
			i++;
		}

		if ((i > 0) && (plyrs[i]))
		{
			console.log('setting startmode');
			self.queue.push({ plid: i, reason: 'startmode'}, -9999, 0, 'startmode');
		}
	}

	self.onLap = function(pkt)
	{
		if (!self.queue.hasNamed('startmode') || (pkt.lapsdone > 0))
			return;

		console.log('removing start mode');

		self.queue.pop('startmode');
	}

	self.onFinish = function(pkt)
	{
		var plyr = this.client.state.getPlyrByPlid(pkt.plid);

		if (plyr.position == 1)
			self.queue.push({ 'name': pkt.plid, reason: 'winner' }, -9999, 20);
	}

	self.onFinalStanding = function(pkt)
	{
		// we only care about our winner
		if (pkt.resultnum != 0)
			return;

		// go back to play if nothing else interesting is happening
		self.queue.push({ plid: pkt.plid, reason: 'final standing' }, 250, 5);
	}

	self.updateLast = function(plus)
	{
		self.last = new Date().getTime() + ((plus) ? plus : 0);
	}

	self.shouldChange = function(cooldown)
	{
		cooldown = cooldown || self.cooldown;
		return (((new Date().getTime()) - self.last) > cooldown);
	}

	self.isCurrent = function(plid)
	{
		return (self.history.current == plid);
	}

	self.change = function(plid, check, back)
	{
		if (check == undefined)
			check = true;

		back = back || false;

		if (check && !self.shouldChange())
		{
			console.log('not changing');
			return;
		}

		if (!self.insim || !self.client)
		{
			console.log('no insim or client!!');
			return;
		}

		var who = 'unknown player';
		var plyr = self.client.state.getPlyrByPlid(plid);
		if (plyr)
			who = plyr.pname;

		self.history.previous = self.history.current;
		self.history.current = plid;

		var cam = self.insim.VIEW_CAM;
		var rand = Math.random();
		if (rand >= 0.9)
			cam = self.insim.VIEW_DRIVER;

		self.log('Switching to ' + who + ' cam=' + cam);

		var pkt = new self.insim.IS_SCC;
		pkt.viewplid = plid;
		pkt.ingamecam = cam;
		self.client.send(pkt);

		self.updateLast();
	}

	self.hunt = function()
	{
		// hunt for interesting things
		self.log('Hunting');

		var grid = {};
		var plyrs = self.client.state.plyrs;

		for (var i in plyrs)
		{
			console.log("plyr %s (%d) x=%d,y=%d,z=%d", plyrs[i].pname, i, plyrs[i].x, plyrs[i].y, plyrs[i].z);
			var nearest = self.track.nearest([ plyrs[i].x, plyrs[i].y, plyrs[i].z ], 1);
			if (!nearest || nearest.length <= 0)
				continue;

			console.log(nearest[0].distance);

			var node = nearest[0].node;

			if (!grid[node.id])
				grid[node.id] = [];

			console.log('splicing in at %d', plyrs[i].position);
			grid[node.id].splice(plyrs[i].position, 0, plyrs[i].plid);
		}

		for (var i in grid)
		{
			for (var j = 0; j < grid[i].length; j++)
			{
				if (!grid[i][j])
				{
					console.log('removing');
					grid[i].splice(j, 1);
					i--;
				}
			}
		}

		console.log(util.inspect(grid));

		var maxId = null;
		var maxV = 0;
		for (var i in grid)
		{
			if (grid[i].length > maxV)
			{
				maxV = grid[i].length;
				maxId = i;
			}
		}

		console.log('most interesting node is ' + maxId + ' with plyrs ' + grid[maxId]);
		var j = 0;
		for (var i in grid[maxId])
		{
			console.log(" - %s (%d) @ pos %d", plyrs[grid[maxId][i]].pname, grid[maxId][i], plyrs[grid[maxId][i]].position);
			j++;
		}

		var score = 100 - (-25 * j);

		var plid = grid[maxId][Math.floor((grid[maxId].length - 1) / 2)];
		self.queue.push({ plid: plid, reason: 'hunted' }, score, 20);
	}

	self.updateLast();
};

var director = new tvDirector;

exports.init = director.init;
exports.term = director.term;
