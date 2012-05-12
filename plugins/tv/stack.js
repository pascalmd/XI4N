"use strict";

(function(exports)
{

/*
 * Simple stack implementation that orders by priority, lower the number the
 * higher it's position. It also understands the idea of expiring items.
 * Expiring items should be set by the number of seconds lifetime.
 * Manually accessing the stack variable will result in Bad Things(tm)
 * When pushing a new item you will get a unique id that you can use for 
 * the lifetime of stack, or until it is reset().
 *
 *
 * var s = new Stack;
 * var x1 = s.push({ 'x': 1 }, 1000);
 * var x2 = s.push({ 'x': 2 }, 10);
 * var x3 = s.push({ 'x': 3 }, 50);
 * 
 * console.log(s.all());
 * 
 * setTimeout(function() {
 * 	s.pop(x1);
 * 
 * 	console.log(s.all());
 * }, 1000);
 */
var Stack = function()
{
	var self = this;

	self.autoId = 0;
	self.stack = [];
	self.length = 0;

	self.expire = function()
	{
		var now = (new Date().getTime());

		self.stack = self.stack.filter(function(e)
		{
			// infinite lifetime when <= 0
			if (e.expires <= 0)
				return true; 

			return (e.expires > now);
		});

		self.length = self.stack.length;
	};

	self.sort = function()
	{
		self.expire();

		self.stack.sort(function(a, b)
		{
			return a.priority - b.priority;
		});
	};

	self.pop = function(id)
	{
		self.expire();

		var e;

		if (id !== undefined)
		{
			for (var i = 0; i < self.stack.length; i++)
			{
				if (!self.stack[i])
					continue;

				if(self.stack[i].id == id)
				{
					e = self.stack[i];
					self.stack.splice(i, 1);
					break;
				}

			}
		}
		else
		{
			e = self.stack.pop();
		}

		self.length = self.stack.length;

        if(e)
        	return e.data;
	};

	self.top = function()
	{
		self.expire();

		var e = self.stack[0];

        if(e)
        	return e.data;
	};

	self.push = function(data, priority, expires)
	{
		var id = self.autoId++;
		var dies = 0;

		if (expires)
			dies = (new Date().getTime()) + (expires * 1000);

        self.stack.push({ 'id': id, 'data': data, 'priority': parseInt(priority), 'expires': dies });
		self.length = self.stack.length;
		self.sort();

		return id;
	};

	self.bottom = function()
	{
		self.expire();

		var e = self.stack[self.stack.length - 1];

        if(e)
        	return e.data;
	};

	self.reset = function()
	{
		self.autoId = 0;
		self.stack = [];
		self.length = 0;
	};

	self.all = function()
	{
		self.expire();

		var r = [];
		for (var i in self.stack)
			r.push(self.stack[i].data);
		return r;
	};

	self.raw = function()
	{
		self.expire();
		return self.stack;
	}
}

// module.exports allows the following magic:
// var func = require('./module.js');
// func(); or var x = new func();

exports = module.exports = Stack;

}(typeof exports === "undefined"
        ? (this.Stack = {})
        : exports));
