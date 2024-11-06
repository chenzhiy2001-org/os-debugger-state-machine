// we recommend the name of BreakpointGroup to be the full file path of the debugged file
// when one file is sufficient for one BreakpointGroup
class BreakpointGroup {
	name: string;
	setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[];
	borders?:Border[]; // can be a border or undefined
	hooks:HookBreakpoints; //cannot be `undefined`. It should at least an empty array `[]`.
	constructor(name: string, setBreakpointsArguments: DebugProtocol.SetBreakpointsArguments[], hooks:HookBreakpoints, borders?:Border[] ) {
		console.log(name);
		this.name = name;
		this.setBreakpointsArguments = setBreakpointsArguments;
		this.hooks = hooks;
		this.borders = borders;
	}
}
//负责断点缓存，转换等
export class BreakpointGroups {
	protected groups: BreakpointGroup[];
	protected currentBreakpointGroupName: string;
	protected nextBreakpointGroup:string;
	protected readonly debugSession: MI2DebugSession; // A "pointer" pointing to debug session
	constructor(currentBreakpointGroupName: string, debugSession: MI2DebugSession, nextBreakpointGroup:string) {
		this.debugSession = debugSession;
		this.groups = [];
		this.groups.push(new BreakpointGroup(currentBreakpointGroupName, [], new HookBreakpoints([]), []));
		this.currentBreakpointGroupName = currentBreakpointGroupName;
		this.nextBreakpointGroup = nextBreakpointGroup;
	}
	// Let GDB remove breakpoints of current breakpoint group
	// but the breakpoints info in current breakpoint group remains unchanged
	public disableCurrentBreakpointGroupBreakpoints() {
		let currentIndex = -1;
		for (let j = 0; j < this.groups.length; j++) {
			if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
				currentIndex = j;
			}
		}
		//我们假设this.groups内缓存的断点信息和GDB里真实的断点信息完全一致。由于设置的断点有时会偏移几行，这不一定会发生。
		//因此，边界断点（Border属性）单独放置，而且边界断点是将已经设好的断点变成边界，因此不会有偏移的问题，从而避开这个问题。
		//未来可以尝试令gdb删除某个文件里的所有断点
		if (currentIndex === -1) {
			return;
		}
		this.groups[currentIndex].setBreakpointsArguments.forEach((e) => {
			this.debugSession.miDebugger.clearBreakPoints(e.source.path);
			this.debugSession.showInformationMessage("disableCurrentBreakpointGroupBreakpoints successed. index= " + currentIndex);
		});
	}
	//功能和disableCurrentBreakpointGroupBreakpoints有重合。
	//断点被触发时会调用该函数。如果空间发生变化（如kernel=>'src/bin/initproc.rs'）
	//缓存旧空间的断点，令GDB清除旧断点组的断点，卸载旧断点组的符号表文件，加载新断点组的符号表文件，加载新断点组的断点
	public updateCurrentBreakpointGroup(updateTo: string) {
		let newIndex = -1;
		for (let i = 0; i < this.groups.length; i++) {
			if (this.groups[i].name === updateTo) {
				newIndex = i;
			}
		}
		if (newIndex === -1) {
			this.groups.push(new BreakpointGroup(updateTo, [], new HookBreakpoints([]), []));
			newIndex = this.groups.length - 1;
		}
		let oldIndex = -1;
		for (let j = 0; j < this.groups.length; j++) {
			if (this.groups[j].name === this.getCurrentBreakpointGroupName()) {
				oldIndex = j;
			}
		}
		if (oldIndex === -1) {
			this.groups.push(new BreakpointGroup(this.getCurrentBreakpointGroupName(), [], new HookBreakpoints([]), []));
			oldIndex = this.groups.length - 1;
		}
		this.groups[oldIndex].setBreakpointsArguments.forEach((e) => {
			this.debugSession.miDebugger.clearBreakPoints(e.source.path);
		});

		let currentBreakpointGroupSymbolFiles:string[] = eval(this.debugSession.breakpointGroupNameToDebugFilePaths)(this.getCurrentBreakpointGroupName());
		for(let f of currentBreakpointGroupSymbolFiles){
			this.debugSession.miDebugger.removeSymbolFile(f);
		}
		
		let nextBreakpointGroupSymbolFiles:string[] = eval(this.debugSession.breakpointGroupNameToDebugFilePaths)(this.groups[newIndex].name);
		for(let f of nextBreakpointGroupSymbolFiles){
			this.debugSession.miDebugger.addSymbolFile(f);
		}

		this.groups[newIndex].setBreakpointsArguments.forEach((args) => {
			this.debugSession.miDebugger.clearBreakPoints(args.source.path).then(
				() => {
					let path = args.source.path;
					if (this.debugSession.isSSH) {
						// convert local path to ssh path
						path = this.debugSession.sourceFileMap.toRemotePath(path);
					}
					const all = args.breakpoints.map((brk) => {
						return this.debugSession.miDebugger.addBreakPoint({
							file: path,
							line: brk.line,
							condition: brk.condition,
							countCondition: brk.hitCondition,
							logMessage: brk.logMessage
						});
					});
				},
				(msg) => {
					//TODO
				}
			);
		});
		this.currentBreakpointGroupName = this.groups[newIndex].name;
		this.debugSession.showInformationMessage("breakpoint group changed to " + updateTo);
	}
	//there should NOT be an `setCurrentBreakpointGroupName()` func because changing currentGroupName also need to change breakpoint group itself, which is what `updateCurrentBreakpointGroup()` does.
	public getCurrentBreakpointGroupName():string {
		return this.currentBreakpointGroupName;
	}
	// notice it can return undefined
	public getBreakpointGroupByName(groupName:string){
		for (const k of this.groups){
			if (k.name === groupName){
				return k;
			}
		}
		return;
	}
	// notice it can return undefined
	public getCurrentBreakpointGroup():BreakpointGroup{
		const groupName = this.getCurrentBreakpointGroupName();
		for (const k of this.groups){
			if (k.name === groupName){
				return k;
			}
		}
		return;
	}
	public getNextBreakpointGroup(){
		return this.nextBreakpointGroup;
	}
	public setNextBreakpointGroup(groupName:string){
		this.nextBreakpointGroup = groupName;
	}
	public getAllBreakpointGroups():readonly BreakpointGroup[]{
		return this.groups;
	}
	// save breakpoint information into a breakpoint group, but NOT let GDB set those breakpoints yet
	public saveBreakpointsToBreakpointGroup(args: DebugProtocol.SetBreakpointsArguments, groupName: string) {
		let found = -1;
		for (let i = 0; i < this.groups.length; i++) {
			if (this.groups[i].name === groupName) {
				found = i;
			}
		}
		if (found === -1) {
			this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([]), []));
			found = this.groups.length - 1;
		}
		let alreadyThere = -1;
		for (let i = 0; i < this.groups[found].setBreakpointsArguments.length; i++) {
			if (this.groups[found].setBreakpointsArguments[i].source.path === args.source.path) {
				this.groups[found].setBreakpointsArguments[i] = args;
				alreadyThere = i;
			}
		}
		if (alreadyThere === -1) {
			this.groups[found].setBreakpointsArguments.push(args);
		}
	}

	public updateBorder(border: Border) {
		const result = eval(this.debugSession.filePathToBreakpointGroupNames)(border.filepath);
		const groupNamesOfBorder:string[] = result;
		for(const groupNameOfBorder of groupNamesOfBorder){
			let groupExists = false;
			for(const group of this.groups){
				if(group.name === groupNameOfBorder){
					groupExists = true;
					group.borders.push(border);
				}
			}
			if(groupExists === false){
				this.groups.push(new BreakpointGroup(groupNameOfBorder, [], new HookBreakpoints([]), [border]));
			}
		}
	}
	// breakpoints are still there but they are no longer borders
	public disableBorder(border: Border) {
		const groupNamesOfBorder:string[] = eval(this.debugSession.filePathToBreakpointGroupNames)(border.filepath);
		for(const groupNameOfBorder of groupNamesOfBorder){
			let groupExists = false;
			for(const group of this.groups){
				if(group.name === groupNameOfBorder){
					groupExists = true;
					group.borders = [];
				}
			}
			if(groupExists === false){
				//do nothing
			}
		}
	}
	public updateHookBreakpoint(hook: HookBreakpointJSONFriendly) {
		const groupNames:string[] = eval(this.debugSession.filePathToBreakpointGroupNames)(hook.breakpoint.file);
		for(const groupName of groupNames){
			let groupExists = false;
			for(const existingGroup of this.groups){
				if(existingGroup.name === groupName){
					groupExists = true;
					existingGroup.hooks.set(toHookBreakpoint(hook));
					this.debugSession.showInformationMessage('hooks set ' + JSON.stringify(existingGroup.hooks));
				}
			}
			if(groupExists === false){
				this.groups.push(new BreakpointGroup(groupName, [], new HookBreakpoints([toHookBreakpoint(hook)]), undefined));
			}
		}
	}
	// the breakpoints are still set, but they will no longer trigger user-defined behavior.
	public disableHookBreakpoint(hook: HookBreakpointJSONFriendly) {
		const groupNames:string[] = eval(this.debugSession.filePathToBreakpointGroupNames)(hook.breakpoint.file);
		for(const groupName of groupNames){
			let groupExists = false;
			for(const existingGroup of this.groups){
				if(existingGroup.name === groupName){
					groupExists = true;
					existingGroup.hooks.remove(hook.breakpoint);
				}
			}
			if(groupExists === false){
				// do nothing
			}
		}
	}

	// 仅用于reset
	public removeAllBreakpoints() {
		this.groups = [];
	}
}
